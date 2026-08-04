import type { FastifyInstance } from "fastify";
import { fileLink } from "../files/link";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  appendWatchNext,
  captionFor,
  decodeEscapes,
  INSTAGRAM_STORY_MAX_SECONDS,
  schedulePostSchema,
  youtubeTitleFor,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The name an operator typed for a video, or "" when they have not.
 *
 * Three field names because the shape was renamed twice: `hook` became
 * `title` became `name`. The read-time normalizer in media.ts maps them the
 * same way, so the queue and the upload list always agree about what a
 * video is called.
 */
function draftName(draft: unknown): string {
  if (!draft || typeof draft !== "object") return "";
  const d = draft as { name?: unknown; title?: unknown; hook?: unknown };
  for (const v of [d.name, d.title, d.hook]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

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

    // Older rows carry {hook, caption} or a `title` that used to mean both
    // the YouTube title and everyone's caption. Fold them onto `name`, which
    // is what every field falls back to, so nothing already drafted changes.
    const stored =
      (asset.draftCopy as {
        name?: string;
        title?: string;
        hook?: string;
        description?: string;
        caption?: string;
        youtubeTitle?: string;
        youtubeDescription?: string;
        hashtags?: string[];
      } | null) ?? {};
    const decodeEscapes = (v: string): string =>
      v.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    const draft = {
      name: decodeEscapes(stored.name ?? stored.title ?? stored.hook ?? ""),
      description: decodeEscapes(stored.description ?? stored.caption ?? ""),
      youtubeTitle: decodeEscapes(stored.youtubeTitle ?? ""),
      youtubeDescription: decodeEscapes(stored.youtubeDescription ?? ""),
    };
    // An explicit caption in the request replaces the body every platform
    // receives, which is what this field has always meant. It does not touch
    // YouTube's title: that is a separate field with its own input.
    const captionOverride = body.caption ? decodeEscapes(body.caption) : "";
    const hashtags = (body.hashtags ?? stored.hashtags ?? []).map(decodeEscapes);
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
    const youtubeBody = captionOverride || captionFor("youtube", draft);

    /*
     * A YouTube upload never leaves here with an empty description.
     *
     * Sending nothing does not produce an empty description on the channel,
     * it produces whatever the provider decides to write: one real upload
     * went out reading "Video uploaded via social media scheduler". The
     * fallback chain covers every case where the operator wrote anything at
     * all, so reaching here means the video has no name, no description and
     * no title, which is not something to publish to a client's channel and
     * quietly let someone else caption.
     */
    /*
     * A carousel is images, and Instagram and TikTok are the platforms that
     * take them here. Refused at schedule time rather than at publish, where
     * it would fail hours later against a client's account with nobody
     * watching. Instagram takes up to 10 items as a plain media list; TikTok
     * takes them as a photo post (its docs allow 35, but one limit keeps
     * every message in this app true). YouTube, Facebook and Snapchat stay
     * out until one has actually gone through them and been looked at.
     */
    if (asset.kind === "carousel") {
      const wrong = accounts.filter(
        ({ platform }) => platform !== "instagram" && platform !== "tiktok",
      );
      if (wrong.length) {
        return reply.status(400).send({
          error: "carousels go to Instagram or TikTok",
          detail: `A carousel is a set of images and only Instagram and TikTok take them here, so ${wrong
            .map((w) => w.platform)
            .join(" and ")} cannot be part of this one.`,
        });
      }
    }

    if (accounts.some(({ platform }) => platform === "youtube") && !youtubeBody) {
      return reply.status(400).send({
        error: "youtube needs words",
        detail:
          "Give this video a name or a description before scheduling it to YouTube. An empty description gets filled in by the scheduler, and that text ends up on your client's channel.",
      });
    }

    const youtubeCaption = appendWatchNext(youtubeBody, ytOptions?.relatedVideoUrl);

    /*
     * "Also share to my story" is a second Instagram post, not a setting on
     * the reel: Instagram treats them as different things and gives a story
     * none of the reel's options. So it becomes its own target, carrying the
     * story flag, alongside the reel.
     */
    const igAccount = accounts.find((a) => a.platform === "instagram");
    const wantsStory = Boolean(igOptions?.alsoStory) && Boolean(igAccount);

    if (wantsStory && asset.durationSec != null && asset.durationSec > INSTAGRAM_STORY_MAX_SECONDS) {
      // Refused here rather than at publish, where it would fail hours later
      // against a client's account with nobody watching.
      return reply.status(400).send({
        error: "too long for a story",
        detail: `Instagram stories stop at ${INSTAGRAM_STORY_MAX_SECONDS} seconds and this video is ${Math.round(asset.durationSec)}. Schedule it without the story, or trim it first.`,
      });
    }

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
            caption:
              platform === "youtube"
                ? youtubeCaption
                : captionOverride || captionFor(platform, draft),
            hashtags,
            scheduledAt,
            status: "scheduled",
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? {
                      youtubeTitle: youtubeTitleFor(draft),
                      ...(ytOptions ? { youtube: ytOptions } : {}),
                    }
                  : platform === "tiktok" && asset.kind === "carousel"
                    ? {
                        // A TikTok photo post has a title of its own (90
                        // chars, hashtags stripped by the platform) separate
                        // from the caption. The video's name is that title.
                        tiktokTitle: draft.name || null,
                        ...(body.tiktok ? { tiktok: body.tiktok } : {}),
                      }
                    : undefined,
          })),
        },
      },
      include: { targets: true },
    });

    // Queued alongside the rest below, not separately: a target with no job
    // is a post that silently never happens.
    const storyTarget = wantsStory
      ? await prisma.postTarget.create({
          data: {
            postId: post.id,
            socialAccountId: igAccount!.account!.id,
            platform: "instagram",
            // Instagram does not display a story's caption, so storing one
            // here would suggest words that never appear.
            caption: null,
            hashtags: [],
            scheduledAt,
            status: "scheduled",
            options: { instagram: { story: true } },
          },
        })
      : null;

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    for (const target of [...post.targets, ...(storyTarget ? [storyTarget] : [])]) {
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
        // The typed name when there is one, so the queue and calendar stop
        // showing raw file names.
        assetName:
          draftName(t.post.mediaAsset?.draftCopy) ||
          t.post.mediaAsset?.originalName ||
          "post",
        // Null once the images were swept a month after posting, the same as
        // the upload list. This is the calendar and the queue, so it is where
        // a link to a deleted file would be most visible: every past card
        // would draw a broken image instead of quietly losing its picture.
        thumbUrl:
          t.post.mediaAsset && !t.post.mediaAsset.thumbDeletedAt
            ? t.post.mediaAsset.coverKey
              ? fileLink(t.post.mediaAsset.coverKey)
              : fileLink(`${t.post.clientId}/${t.post.mediaAsset.id}/thumb.jpg`)
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
