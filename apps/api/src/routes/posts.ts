import type { FastifyInstance } from "fastify";
import { fileLink } from "../files/link";
import {
  captionFor,
  carouselVerdict,
  decodeEscapes,
  INSTAGRAM_FEED_MAX_SECONDS,
  INSTAGRAM_STORY_MAX_SECONDS,
  schedulePostSchema,
  scheduleTimeError,
  youtubeTitleFor,
  type Platform,
} from "@toreroflow/core";
import { getPrisma, cancelByKey, enqueue, reschedule } from "@toreroflow/db";
import { enrichFieldsFrom } from "@toreroflow/publishers";
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
    /*
     * A past time is not a harmless typo here. The publish worker runs a job
     * whose moment has already gone as soon as it is queued, so scheduling for
     * yesterday publishes to a client's account immediately, and that is not
     * something an apology undoes.
     */
    const whenError = scheduleTimeError(scheduledAt);
    if (whenError) {
      return reply.status(400).send({ error: "invalid scheduledAt", detail: whenError });
    }

    /*
     * Two ways to say where this goes. accountIds is the precise one: the
     * picker sends the exact accounts ticked, which is what makes two pages
     * on one platform two separate destinations. platforms alone is the
     * older form, and its "first connected account per platform" resolution
     * is kept for callers that predate accounts being distinguishable.
     */
    const accounts = body.accountIds
      ? body.accountIds.map((id) => {
          const account = asset.client.socialAccounts.find(
            (a) => a.id === id && a.status === "connected",
          );
          return { platform: account?.platform as Platform, account };
        })
      : body.platforms.map((platform) => {
          const account = asset.client.socialAccounts.find(
            (a) => a.platform === platform && a.status === "connected",
          );
          return { platform, account };
        });
    const missing = accounts.filter((a) => !a.account);
    if (missing.length) {
      return reply.status(400).send({
        error: body.accountIds
          ? "an account in this schedule is not connected"
          : `not connected: ${missing.map((a) => a.platform).join(", ")}`,
      });
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
    // The wizard's own editor wins over draft-derived copy where it spoke.
    const youtubeBody =
      ytOptions?.description || captionOverride || captionFor("youtube", draft);

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

      /*
       * The composition rules, enforced where the builder already warned.
       * The builder disables the ineligible platform live, but a request is
       * not the builder, and a publish failure hours later on a client's
       * account is the expensive way to learn these.
       */
      const slides = Array.isArray(asset.slideKeys) ? (asset.slideKeys as string[]) : [];
      const verdict = carouselVerdict(
        slides.map((k) => ({ kind: /\.(mp4|mov)$/i.test(k) ? "video" : "image" })),
      );
      if (accounts.some(({ platform }) => platform === "instagram") && !verdict.instagram.eligible) {
        return reply
          .status(400)
          .send({ error: "too many for Instagram", detail: verdict.instagram.reason });
      }
      if (accounts.some(({ platform }) => platform === "tiktok") && !verdict.tiktok.eligible) {
        return reply
          .status(400)
          .send({ error: "TikTok cannot take this set", detail: verdict.tiktok.reason });
      }
    }

    if (accounts.some(({ platform }) => platform === "youtube") && !youtubeBody) {
      return reply.status(400).send({
        error: "youtube needs words",
        detail:
          "Give this video a name or a description before scheduling it to YouTube. An empty description gets filled in by the scheduler, and that text ends up on your client's channel.",
      });
    }

    /*
     * "Also share to my story" is a second Instagram post, not a setting on
     * the reel: Instagram treats them as different things and gives a story
     * none of the reel's options. So it becomes its own target, carrying the
     * story flag, alongside the reel.
     */
    const igAccount = accounts.find((a) => a.platform === "instagram");
    const wantsStory = Boolean(igOptions?.alsoStory) && Boolean(igAccount);

    /*
     * Only a genuinely absurd video is refused now.
     *
     * Over 90 seconds it stops being a reel and goes as a feed post, which
     * Instagram takes up to an hour of; buildPostExtras makes that call from
     * the duration. The reel limit is a placement limit, not a publishing one,
     * and treating it as the latter is what left a client's video unposted for
     * three days.
     */
    if (
      igAccount &&
      asset.durationSec != null &&
      asset.durationSec > INSTAGRAM_FEED_MAX_SECONDS
    ) {
      return reply.status(400).send({
        error: "too long for Instagram",
        detail: `Instagram stops at ${Math.round(INSTAGRAM_FEED_MAX_SECONDS / 60)} minutes and this video is ${Math.round(asset.durationSec / 60)}. Trim it, or untick Instagram.`,
      });
    }

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
                ? youtubeBody
                : captionOverride || captionFor(platform, draft),
            hashtags,
            scheduledAt,
            status: "scheduled",
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? {
                      youtubeTitle: ytOptions?.title || youtubeTitleFor(draft),
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

    for (const target of [...post.targets, ...(storyTarget ? [storyTarget] : [])]) {
      // Keyed on the target so a reschedule can move this exact job, and so a
      // double submit cannot queue the same post twice.
      await enqueue(
        "publish",
        { targetId: target.id },
        {
          key: target.id,
          startAfter: scheduledAt,
          retryLimit: 3,
          retryDelaySeconds: 30,
          retryBackoff: true,
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
        /*
         * The platform's own id and link for a published post.
         *
         * Exposed so the app can send an operator straight to the video on the
         * platform. YouTube is the reason: its Shorts "Related video" pin has
         * no API on anyone's side, so the only way to set one is by hand in
         * Studio, and a deep link is the difference between that being a
         * two-click job and a hunt through a channel.
         */
        remotePostId: t.remotePostId,
        remoteUrl: t.remoteUrl,
        /*
         * The long-form wizard's afterlife, distilled for the calendar card:
         * what a human still has to do in Studio, and where the automatic
         * metadata application stands. Null for everything that never went
         * through the wizard, which is every short-form post ever made.
         */
        youtube: (() => {
          if (t.platform !== "youtube") return null;
          const yt = ((t.options as Record<string, unknown> | null) ?? {}).youtube as
            | Record<string, unknown>
            | undefined;
          if (!yt) return null;
          const studioTasks = Array.isArray(yt.studioTasks)
            ? (yt.studioTasks as string[]).filter((x) => typeof x === "string")
            : [];
          const wantsEnrich = enrichFieldsFrom(t.options) !== null;
          const enrich = yt.enrichedAt
            ? ({ state: "applied", detail: String(yt.enrichedAt) } as const)
            : typeof yt.enrichError === "string"
              ? ({ state: "error", detail: yt.enrichError } as const)
              : wantsEnrich
                ? ({ state: "pending", detail: null } as const)
                : null;
          if (!studioTasks.length && !enrich) return null;
          return { studioTasks, enrich };
        })(),
        // Captions saved before emoji decoding landed still hold literal
        // "\uXXXX" text; clean them on the way out.
        caption: t.caption ? decodeEscapes(t.caption) : t.caption,
        // The typed name when there is one, so the queue and calendar stop
        // showing raw file names.
        assetName:
          draftName(t.post.mediaAsset?.draftCopy) ||
          t.post.mediaAsset?.originalName ||
          "post",
        // video | carousel, with the slide count, so the queue and calendar
        // can mark a set of images as what it is instead of dressing it as a
        // video.
        assetKind: t.post.mediaAsset?.kind ?? "video",
        slideCount: Array.isArray(t.post.mediaAsset?.slideKeys)
          ? (t.post.mediaAsset.slideKeys as unknown[]).length
          : 0,
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
      // Same rule as scheduling, and it has to be repeated because dragging a
      // card across the calendar reaches this route and never the other one.
      const whenError = when
        ? scheduleTimeError(when)
        : "That is not a valid date and time.";
      if (!when || whenError) {
        return reply.status(400).send({ error: "invalid scheduledAt", detail: whenError });
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
      // One statement, so unlike the old remove-then-add there is no instant
      // where this post is queued nowhere.
      await reschedule("publish", { targetId: target.id }, target.id, when);
      return { id: updated.id, scheduledAt: updated.scheduledAt };
    },
  );


  /**
   * Put a failed target back on the queue, now.
   *
   * A retry moves scheduledAt to the present rather than keeping the time that
   * already passed, because publishTarget refuses to run a job more than a
   * minute ahead of its slot and the calendar should show when the video
   * actually goes out. That is a deliberate difference from the boot-time
   * re-queue, which leaves stale targets alone: this one is an operator
   * standing there choosing to send it late.
   *
   * `tiktokDraft` retries into the client's TikTok inbox instead of publishing.
   * It is the only same-day answer to TikTok's app-level daily cap, and it is
   * an explicit choice rather than an automatic fallback: the provider does not
   * document whether the inbox route escapes that cap, so guessing would spend
   * a second failure to find out and look like the retry itself was broken.
   */
  app.post<{ Params: { id: string }; Body: { tiktokDraft?: boolean } }>(
    "/posts/targets/:id/retry",
    async (request, reply) => {
      const target = await prisma.postTarget.findFirst({
        where: {
          id: request.params.id,
          post: { client: { agencyId: request.user.agencyId } },
        },
        include: { post: { select: { id: true } } },
      });
      if (!target) return reply.status(404).send({ error: "target not found" });
      /*
       * Only a failed target may be retried, and "publishing" is excluded on
       * purpose rather than by omission: that status means a container is in
       * flight at the platform and confirmPublishing is still waiting on it.
       * Re-queueing one is how a client gets the same video twice.
       */
      if (target.status !== "failed") {
        return reply
          .status(409)
          .send({ error: `only failed posts can be retried; this one is ${target.status}` });
      }

      const draft = request.body?.tiktokDraft === true;
      if (draft && target.platform !== "tiktok") {
        return reply.status(400).send({ error: "the inbox route is TikTok only" });
      }

      const options = (target.options as Record<string, unknown> | null) ?? {};
      const nextOptions = draft
        ? {
            ...options,
            tiktok: { ...((options.tiktok as Record<string, unknown>) ?? {}), draft: true },
          }
        : options;

      const when = new Date();
      await prisma.postTarget.update({
        where: { id: target.id },
        data: {
          status: "scheduled",
          // Cleared so a second failure shows its own reason rather than the
          // last one, which is what makes "it failed the same way" readable.
          error: null,
          scheduledAt: when,
          options: nextOptions as never,
        },
      });

      /*
       * The post itself was marked failed when its last target gave up. Lift
       * that only while something is in flight again; the remaining targets
       * keep their own statuses and the next failure re-marks it.
       */
      await prisma.post.update({
        where: { id: target.post.id },
        data: { status: "scheduled" },
      });

      await reschedule("publish", { targetId: target.id }, target.id, when);
      return { id: target.id, scheduledAt: when.toISOString(), tiktokDraft: draft };
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

      await cancelByKey("publish", target.id);
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
      await cancelByKey("publish", target.id);
    }
    await prisma.postTarget.deleteMany({ where: { postId: post.id } });
    await prisma.post.delete({ where: { id: post.id } });
    return { ok: true };
  });
}
