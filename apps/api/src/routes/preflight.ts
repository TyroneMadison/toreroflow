import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import {
  canOverridePreflight,
  OverrideRequestSchema,
  OverridesSchema,
  PreflightRequestSchema,
  WorkflowPlatformSchema,
  type OverrideLog,
} from "@toreroflow/contracts";
import { requireAuth, principalOf } from "../plugins/requireAuth";
import { actingUserId } from "../auth/actingUser";
import { runPreflight, type PreflightTarget } from "../workflow/preflight";

/**
 * W2: POST /preflight checks every target of a draft (a Post and its
 * PostTargets) at once. POST /drafts/:id/override lets the operator or a
 * full-access bot (Polly) post past blocking issues, always with a reason,
 * logged with the actor and time.
 */
export async function preflightRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.post("/preflight", async (request, reply) => {
    const body = PreflightRequestSchema.parse(request.body);
    const post = await prisma.post.findFirst({
      where: { id: body.draftId, deletedAt: null, client: { agencyId: request.user.agencyId } },
      include: { targets: true, mediaAsset: true },
    });
    if (!post) return reply.status(404).send({ error: "draft not found" });
    const asset = post.mediaAsset;
    const assetCover = asset?.coverKey ?? (asset?.coverOffsetMs != null ? `frame:${asset.coverOffsetMs}` : null);
    const targets: PreflightTarget[] = [];
    for (const t of post.targets) {
      const platform = WorkflowPlatformSchema.safeParse(t.platform);
      const options = (t.options ?? {}) as { youtubeTitle?: string; instagram?: { story?: boolean } };
      // A story shows no caption or cover; nothing here applies to it.
      if (!platform.success || options.instagram?.story) continue;
      const o = OverridesSchema.safeParse(t.overrides);
      const overrides = o.success ? o.data : {};
      const tagLine = t.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
      targets.push({
        platform: platform.data,
        caption: [overrides.caption ?? t.caption ?? "", tagLine].filter(Boolean).join("\n\n"),
        title: overrides.title ?? options.youtubeTitle ?? null,
        // A carousel's first slide is its cover.
        cover: overrides.cover ?? (asset?.kind === "carousel" ? asset.storageKey : assetCover),
        videoSeconds: asset?.kind === "video" ? asset.durationSec : null,
      });
    }
    return runPreflight({ draftId: post.id, targets, kit: body.brandKit ?? null, design: body.design ?? null });
  });

  app.post<{ Params: { id: string } }>("/drafts/:id/override", async (request, reply) => {
    const principal = principalOf(request);
    if (!canOverridePreflight(principal)) {
      return reply.status(403).send({ error: "only the operator or Polly can override preflight" });
    }
    const parsed = OverrideRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "a reason is required (3 to 500 characters)" });
    const post = await prisma.post.findFirst({
      where: { id: request.params.id, deletedAt: null, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!post) return reply.status(404).send({ error: "draft not found" });
    let actor: OverrideLog["actor"];
    if (principal.role === "bot") {
      actor = { kind: "bot", bot: principal.bot.name };
    } else {
      const userId = await actingUserId(request);
      if (!userId) return reply.status(401).send({ error: "unknown user" });
      actor = { kind: "operator", userId };
    }
    const row = await prisma.preflightOverride.create({
      data: {
        postId: post.id,
        reason: parsed.data.reason,
        actorKind: actor.kind,
        actorId: actor.kind === "bot" ? actor.bot : actor.userId,
      },
    });
    request.log.info({ draftId: post.id, actor }, "preflight override");
    const log: OverrideLog = { id: row.id, draftId: post.id, reason: row.reason, actor, at: row.createdAt.toISOString() };
    return log;
  });
}
