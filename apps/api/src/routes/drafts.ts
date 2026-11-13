import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import {
  DraftUpsertSchema,
  OverridesSchema,
  WorkflowPlatformSchema,
  type Draft,
} from "@toreroflow/contracts";
import { principalOf, requireAuth } from "../plugins/requireAuth";
import { actingUserId } from "../auth/actingUser";

/**
 * W1 drafts: GET and PUT /drafts/:id, saving only. A draft is a Post with
 * status "draft" and one PostTarget per platform. Post has no column for the
 * draft-wide caption, title and postAt, so each target carries them: caption
 * in PostTarget.caption, title in options.youtubeTitle (where preflight reads
 * them), postAt in options.draftPostAt. scheduledAt stays null and no job is
 * enqueued, so the worker, the calendar and the daily counter (all keyed on
 * scheduledAt) never see a draft. The calendar, the queue and the ready list
 * skip draft posts outright. Scheduling stays in POST /media/:id/schedule.
 *
 * PUT creates the draft when the id is new, replaces it while it is still a
 * draft, and refuses (409) once it is scheduled or published. An id, brand or
 * video outside the caller's agency is 404. Bots reach this only with full
 * access (Polly): the route is not on the bot whitelist.
 */
type Options = { youtubeTitle?: string; draftPostAt?: string };

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const load = (id: string) =>
    prisma.post.findUnique({
      where: { id },
      include: { client: { select: { agencyId: true } }, targets: { orderBy: { createdAt: "asc" } } },
    });
  type Row = NonNullable<Awaited<ReturnType<typeof load>>>;

  const toDraft = (p: Row): Draft => {
    const first = p.targets[0];
    const options = (first?.options ?? {}) as Options;
    const postAt = options.draftPostAt ?? (first?.scheduledAt ?? p.createdAt).toISOString();
    return {
      id: p.id,
      brandId: p.clientId,
      videoId: p.mediaAssetId ?? "",
      caption: first?.caption ?? "",
      ...(options.youtubeTitle !== undefined ? { title: options.youtubeTitle } : {}),
      postAt,
      targets: p.targets.flatMap((t) => {
        const platform = WorkflowPlatformSchema.safeParse(t.platform);
        if (!platform.success) return [];
        const o = OverridesSchema.safeParse(t.overrides);
        return [{ platform: platform.data, overrides: o.success ? o.data : {} }];
      }),
    };
  };

  app.get<{ Params: { id: string } }>("/drafts/:id", async (request, reply) => {
    const post = await load(request.params.id);
    if (!post || post.deletedAt || post.client.agencyId !== request.user.agencyId) {
      return reply.status(404).send({ error: "draft not found" });
    }
    return toDraft(post);
  });

  app.put<{ Params: { id: string } }>("/drafts/:id", async (request, reply) => {
    if (principalOf(request).role === "viewer") return reply.status(403).send({ error: "viewers cannot save drafts" });
    const id = request.params.id;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply.status(400).send({ error: "invalid draft id" });
    const parsed = DraftUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid draft", detail: parsed.error.issues });
    const body = parsed.data;
    const platforms = body.targets.map((t) => t.platform);
    if (!platforms.length) return reply.status(400).send({ error: "a draft needs at least one target" });
    if (new Set(platforms).size !== platforms.length) return reply.status(400).send({ error: "one target per platform" });

    const agencyId = request.user.agencyId;
    const existing = await load(id);
    if (existing && (existing.deletedAt || existing.client.agencyId !== agencyId)) {
      return reply.status(404).send({ error: "draft not found" });
    }
    if (existing && existing.status !== "draft") {
      return reply.status(409).send({ error: `this post is already ${existing.status}; change it from the calendar` });
    }
    const brand = await prisma.client.findFirst({ where: { id: body.brandId, agencyId, deletedAt: null }, select: { id: true } });
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    const video = await prisma.mediaAsset.findFirst({ where: { id: body.videoId, clientId: brand.id }, select: { id: true } });
    if (!video) return reply.status(404).send({ error: "video not found for this brand" });
    const accounts = await prisma.socialAccount.findMany({
      where: { clientId: brand.id, platform: { in: platforms } },
      orderBy: { connectedAt: "asc" },
      select: { id: true, platform: true },
    });
    const accountOf = (platform: string) => accounts.find((a) => a.platform === platform)?.id;
    const missing = platforms.filter((p) => !accountOf(p));
    if (missing.length) return reply.status(400).send({ error: `no ${missing.join(", ")} account for this brand` });

    const createdById = existing?.createdById ?? (await actingUserId(request));
    if (!createdById) return reply.status(401).send({ error: "unknown user" });

    const options: Options = { ...(body.title !== undefined ? { youtubeTitle: body.title } : {}), draftPostAt: body.postAt };
    // Draft fields only: status stays draft, scheduledAt null, nothing enqueued.
    const fields = (t: (typeof body.targets)[number]) => ({
      socialAccountId: accountOf(t.platform)!,
      caption: body.caption,
      options,
      // The whole overrides object replaces the stored one: an absent key is a reset.
      overrides: t.overrides,
      scheduledAt: null,
    });
    await prisma.$transaction(async (tx) => {
      if (!existing) {
        await tx.post.create({ data: { id, clientId: brand.id, mediaAssetId: video.id, createdById, status: "draft" } });
      } else {
        await tx.post.update({ where: { id }, data: { clientId: brand.id, mediaAssetId: video.id } });
        await tx.postTarget.deleteMany({ where: { postId: id, platform: { notIn: platforms } } });
      }
      for (const t of body.targets) {
        const prior = existing?.targets.find((x) => x.platform === t.platform);
        if (prior) await tx.postTarget.update({ where: { id: prior.id }, data: fields(t) });
        else await tx.postTarget.create({ data: { postId: id, platform: t.platform, ...fields(t) } });
      }
    });
    return toDraft((await load(id))!);
  });
}
