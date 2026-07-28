import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { decodeEscapes, schedulePostSchema, appendWatchNext } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

export async function postRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const publishQueue = new Queue<{ targetId: string }>("publish", { connection });

  app.addHook("onRequest", requireAuth);

  /** Schedule a processed video to one or more connected platforms. */
  app.post<{ Params: { id: string } }>("/media/:id/schedule", async (request, reply) => {
    const body = schedulePostSchema.parse(request.body);
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
      include: {
        client: { include: { socialAccounts: { where: { deletedAt: null } } } },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    if (asset.status !== "ready") {
      return reply.status(409).send({ error: "asset is still processing" });
    }

    const scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return reply.status(400).send({ error: "invalid scheduledAt" });
    }

    const accounts = body.platforms.map((platform) => {
      const account = asset.client.socialAccounts.find(
        (a) => a.platform === platform && a.status === "connected",
      );
      return { platform, account };
    });
    const missing = accounts.filter((a) => !a.account).map((a) => a.platform);
    if (missing.length) {
      return reply
        .status(400)
        .send({ error: `not connected: ${missing.join(", ")}` });
    }

    // The title is what actually gets posted: YouTube's title, and the
    // caption on Instagram and TikTok. `hook` is the pre-rename field name,
    // still present on assets drafted before the change.
    const draft =
      (asset.draftCopy as {
        title?: string;
        hook?: string;
        description?: string;
        hashtags?: string[];
      } | null) ?? {};
    const decodeEscapes = (v: string): string =>
      v.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    const rawCaption = body.caption ?? draft.title ?? draft.hook ?? "";
    const caption = decodeEscapes(rawCaption);
    const hashtags = (body.hashtags ?? draft.hashtags ?? []).map(decodeEscapes);
    // YouTube's caption is the description; everywhere else the title IS the
    // caption. The description was being written and never sent before this.
    const description = decodeEscapes(draft.description ?? "");
    // Collaborators arrive as typed usernames; strip the @ some people type.
    const igOptions = body.instagram
      ? {
          ...body.instagram,
          collaborators: body.instagram.collaborators
            ?.map((c) => c.trim().replace(/^@/, ""))
            .filter(Boolean),
        }
      : undefined;

    const ytOptions = body.youtube;
    const youtubeDescription = appendWatchNext(description, ytOptions?.relatedVideoUrl);

    const post = await prisma.post.create({
      data: {
        clientId: asset.clientId,
        mediaAssetId: asset.id,
        createdById: request.user.sub,
        status: "scheduled",
        targets: {
          create: accounts.map(({ platform, account }) => ({
            socialAccountId: account!.id,
            platform,
            caption: platform === "youtube" && youtubeDescription ? youtubeDescription : caption,
            hashtags,
            scheduledAt,
            status: "scheduled",
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? { youtubeTitle: caption, ...(ytOptions ? { youtube: ytOptions } : {}) }
                  : undefined,
          })),
        },
      },
      include: { targets: true },
    });

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    for (const target of post.targets) {
      // jobId = target id so a reschedule can replace the delayed job.
      await publishQueue.add(
        "publish",
        { targetId: target.id },
        {
          jobId: target.id,
          delay,
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }

    return reply.status(201).send({
      id: post.id,
      scheduledAt,
      targets: post.targets.map((t) => ({
        id: t.id,
        platform: t.platform,
        status: t.status,
      })),
    });
  });

  /** Post targets for calendar and queue views. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/clients/:id/posts",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
      });
      if (!client) return reply.status(404).send({ error: "client not found" });

      const from = request.query.from ? new Date(request.query.from) : undefined;
      const to = request.query.to ? new Date(request.query.to) : undefined;
      const targets = await prisma.postTarget.findMany({
        where: {
          post: { clientId: client.id, deletedAt: null },
          ...(from || to
            ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
        },
        orderBy: { scheduledAt: "asc" },
        include: { post: { include: { mediaAsset: true } } },
      });
      return targets.map((t) => ({
        id: t.id,
        postId: t.postId,
        platform: t.platform,
        status: t.status,
        scheduledAt: t.scheduledAt,
        publishedAt: t.publishedAt,
        error: t.error,
        // Captions saved before emoji decoding landed still hold literal
        // "\uXXXX" text; clean them on the way out.
        caption: t.caption ? decodeEscapes(t.caption) : t.caption,
        assetName: t.post.mediaAsset?.originalName ?? "post",
        thumbUrl: t.post.mediaAsset
          ? t.post.mediaAsset.coverKey
            ? `/files/${t.post.mediaAsset.coverKey}`
            : `/files/${t.post.clientId}/${t.post.mediaAsset.id}/thumb.jpg`
          : null,
      }));
    },
  );

  /** Drag-to-reschedule: move one target and replace its delayed job. */
  app.patch<{ Params: { id: string } }>(
    "/posts/targets/:id/reschedule",
    async (request, reply) => {
      const body = (request.body ?? {}) as { scheduledAt?: string };
      const when = body.scheduledAt ? new Date(body.scheduledAt) : null;
      if (!when || Number.isNaN(when.getTime())) {
        return reply.status(400).send({ error: "invalid scheduledAt" });
      }
      const target = await prisma.postTarget.findFirst({
        where: {
          id: request.params.id,
          post: { client: { agencyId: request.user.agencyId } },
        },
      });
      if (!target) return reply.status(404).send({ error: "target not found" });
      if (target.status !== "scheduled") {
        return reply.status(409).send({ error: "only scheduled posts can move" });
      }

      const updated = await prisma.postTarget.update({
        where: { id: target.id },
        data: { scheduledAt: when },
      });
      const existing = await publishQueue.getJob(target.id);
      if (existing) await existing.remove();
      await publishQueue.add(
        "publish",
        { targetId: target.id },
        {
          jobId: target.id,
          delay: Math.max(0, when.getTime() - Date.now()),
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return { id: updated.id, scheduledAt: updated.scheduledAt };
    },
  );

  /**
   * Remove one scheduled target (a single platform) and its delayed job.
   * Several targets share a post, so the post itself only goes when its
   * last target does.
   */
  app.delete<{ Params: { id: string } }>("/posts/targets/:id", async (request, reply) => {
    const target = await prisma.postTarget.findFirst({
      where: {
        id: request.params.id,
        post: { client: { agencyId: request.user.agencyId } },
      },
    });
    if (!target) return reply.status(404).send({ error: "target not found" });
    if (target.status === "posted" || target.status === "publishing") {
      return reply.status(409).send({ error: "already publishing or posted" });
    }

    const job = await publishQueue.getJob(target.id);
    if (job) await job.remove();
    await prisma.postTarget.delete({ where: { id: target.id } });

    const left = await prisma.postTarget.count({ where: { postId: target.postId } });
    if (left === 0) {
      await prisma.post.delete({ where: { id: target.postId } });
    }
    return { ok: true, postRemoved: left === 0 };
  });

  /** Cancel a scheduled post (all targets still unpublished). */
  app.delete<{ Params: { id: string } }>("/posts/:id", async (request, reply) => {
    const post = await prisma.post.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
      include: { targets: true },
    });
    if (!post) return reply.status(404).send({ error: "post not found" });
    if (post.targets.some((t) => t.status === "posted" || t.status === "publishing")) {
      return reply.status(409).send({ error: "post already publishing or posted" });
    }
    for (const target of post.targets) {
      const job = await publishQueue.getJob(target.id);
      if (job) await job.remove();
    }
    await prisma.postTarget.deleteMany({ where: { postId: post.id } });
    await prisma.post.delete({ where: { id: post.id } });
    return { ok: true };
  });
}
