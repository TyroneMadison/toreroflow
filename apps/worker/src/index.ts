import path from "node:path";
import fs from "node:fs/promises";
import { carouselTargetSize, formatFromDuration } from "@toreroflow/core";
import {
  getPrisma,
  Prisma,
  persistProviderPosts,
  reschedule,
  scheduleCron,
  upsertExternalVideo,
  work,
} from "@toreroflow/db";
import { conformSlide, extractThumbnail, probe, type CropRect } from "@toreroflow/media";
import { env } from "./env";
import { isolateVoice, processEditAsset, renderProject } from "./edit";
import { runAnalysis } from "./analyze";
import { extractKnowledgeFile } from "./knowledge";
import { generateInsight } from "./insights";
import { runResearch } from "./research";
import { sweepPostedSources, sweepPostedThumbnails } from "./retention";
import { syncAllBanks, syncBankConnection } from "./bank";
import { checkFilingReminders } from "./filing";

const prisma = getPrisma();

/**
 * Conform a carousel's slides to one geometry and make it ready.
 *
 * The route stored the originals untouched plus a crops.json holding the
 * builder's pan/zoom rects. Both platforms force every item in a set to the
 * first item's aspect ratio, so that ratio (from its crop when one was made,
 * from the file itself otherwise) decides the target size, and every slide is
 * cut to it: images become JPEGs (which also converts WebP into something
 * Instagram accepts), videos become H.264 at the same frame size.
 *
 * Originals and the crops file are deleted on success. They were only ever
 * inputs, and a carousel's storage story is its finished slides.
 */
async function processCarousel(assetId: string, clientId: string): Promise<void> {
  const dir = path.join(env.STORAGE_DIR, clientId, assetId);
  await prisma.mediaAsset.update({ where: { id: assetId }, data: { status: "processing" } });
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, "crops.json"), "utf8")) as {
      originals: string[];
      crops: Array<CropRect | null>;
    };

    const firstAbs = path.join(dir, raw.originals[0]!);
    const firstCrop = raw.crops[0] ?? null;
    let ratio: number;
    if (firstCrop) {
      ratio = firstCrop.width / firstCrop.height;
    } else {
      const meta = await probe(firstAbs);
      ratio = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : 1;
    }
    const target = carouselTargetSize(ratio);

    const finalKeys: string[] = [];
    for (let i = 0; i < raw.originals.length; i++) {
      const original = raw.originals[i]!;
      const isVideo = /\.(mp4|mov)$/i.test(original);
      const outName = `slide-${i + 1}.${isVideo ? "mp4" : "jpg"}`;
      await conformSlide(
        path.join(dir, original),
        path.join(dir, outName),
        target,
        raw.crops[i] ?? null,
      );
      finalKeys.push(`${clientId}/${assetId}/${outName}`);
    }

    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { slideKeys: finalKeys, storageKey: finalKeys[0]!, status: "ready" },
    });

    // Inputs only: the finished slides are the carousel now.
    for (const original of raw.originals) {
      await fs.rm(path.join(dir, original), { force: true });
    }
    await fs.rm(path.join(dir, "crops.json"), { force: true });
    console.log(`[worker] carousel ${assetId} ready (${finalKeys.length} slides, ${target.width}x${target.height})`);
  } catch (error) {
    console.error(`[worker] carousel ${assetId} failed:`, error);
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { status: "failed" } });
    throw error;
  }
}

async function processAsset(assetId: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: { client: true },
  });
  if (!asset) return;
  if (asset.kind === "carousel") return processCarousel(asset.id, asset.clientId);

  const assetDir = path.join(env.STORAGE_DIR, asset.clientId, asset.id);
  const sourcePath = path.join(env.STORAGE_DIR, asset.storageKey);
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { status: "processing" },
  });

  try {
    // 1. Probe. Duration also decides short vs long form for the client's
    // quota, but never overrides a format the operator already set.
    const meta = await probe(sourcePath);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        ...(asset.format === null
          ? { format: formatFromDuration(meta.durationSec) }
          : {}),
      },
    });

    // 2. Thumbnail from the source video itself.
    // The video is never re-encoded: it publishes exactly as exported, so
    // there is no reframe and no burned-in captions.
    //
    // Transcription used to sit between these two, on every upload. It is free
    // and local, which is why it was allowed to, but free is not the same as
    // fast: it is the longest part of the job by far, and it held a video at
    // "processing" for as long as it took while the operator waited to do
    // anything with a file that was already safely stored. Most uploads never
    // needed it. The "Generate caption and title" button already transcribes a
    // video that has no transcript, so the words are made when something
    // actually wants to read them.
    const thumbAt = Math.min(1, (meta.durationSec || 1) * 0.25);
    await extractThumbnail(sourcePath, path.join(assetDir, "thumb.jpg"), thumbAt);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "ready" },
    });
    console.log(`[worker] asset ${asset.id} ready (${Math.round(meta.durationSec)}s)`);
  } catch (error) {
    console.error(`[worker] asset ${asset.id} failed:`, error);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "failed" },
    });
    throw error;
  }
}

/* ---- publish pipeline (spec Section 10) ---- */

import {
  buildPostExtras,
  DryRunPublisher,
  YouTubeProvider,
  ZernioProvider,
} from "@toreroflow/publishers";
import type { Platform } from "@toreroflow/core";

const zernio =
  env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
    ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
    : null;
const youtube = env.YOUTUBE_API_KEY ? new YouTubeProvider(env.YOUTUBE_API_KEY) : null;

/**
 * Refresh lifetime YouTube catalogues for every connected channel.
 *
 * The provider only reports a recent window, so all-time view counts have
 * to come from YouTube itself and drift as videos keep accumulating views.
 * Upserts keep this idempotent; one bad channel never stops the rest.
 */
async function refreshYouTubeCatalogues(): Promise<void> {
  if (!youtube) return;
  const accounts = await prisma.socialAccount.findMany({
    where: { deletedAt: null, platform: "youtube", client: { deletedAt: null } },
    select: { id: true, handle: true },
  });
  if (!accounts.length) return;

  let total = 0;
  for (const account of accounts) {
    try {
      const { videos } = await youtube.allVideosForChannel(account.handle);
      for (const v of videos) {
        await upsertExternalVideo(prisma, {
          socialAccountId: account.id,
          platform: "youtube",
          platformVideoId: v.platformVideoId,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          publishedAt: new Date(v.publishedAt),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          durationSec: v.durationSec,
        });
      }
      total += videos.length;
    } catch (error) {
      console.error(`[worker] youtube refresh failed for @${account.handle}:`, error);
    }
  }
  console.log(`[worker] youtube lifetime refresh: ${total} videos across ${accounts.length} channels`);
}

/** Zernio media URLs are reusable for 7 days; cache per asset per process. */
const mediaUrlCache = new Map<string, string>();

async function zernioMediaUrl(assetId: string, filePath: string): Promise<string> {
  const cached = mediaUrlCache.get(assetId);
  if (cached) return cached;
  const { uploadUrl, publicUrl } = await zernio!.presignMedia(
    path.basename(filePath),
    "video/mp4",
  );
  const body = await fs.readFile(filePath);
  await zernio!.uploadMedia(uploadUrl, body, "video/mp4");
  mediaUrlCache.set(assetId, publicUrl);
  return publicUrl;
}

/**
 * Covers are re-uploaded on every publish on purpose: a re-picked frame
 * overwrites the same file path, so any cache keyed on the path would
 * silently post the old image.
 */
/** Presign and upload one carousel slide, image or video, typed by extension. */
async function zernioSlideUrl(key: string): Promise<string> {
  const contentType = /\.(mp4|mov)$/i.test(key)
    ? "video/mp4"
    : key.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  const filePath = path.join(env.STORAGE_DIR, key);
  const { uploadUrl, publicUrl } = await zernio!.presignMedia(path.basename(key), contentType);
  const body = await fs.readFile(filePath);
  await zernio!.uploadMedia(uploadUrl, body, contentType);
  return publicUrl;
}

async function zernioImageUrl(coverKey: string): Promise<string> {
  const contentType = coverKey.endsWith(".png") ? "image/png" : "image/jpeg";
  const filePath = path.join(env.STORAGE_DIR, coverKey);
  const { uploadUrl, publicUrl } = await zernio!.presignMedia(
    path.basename(coverKey),
    contentType,
  );
  const body = await fs.readFile(filePath);
  await zernio!.uploadMedia(uploadUrl, body, contentType);
  return publicUrl;
}

const PUBLISH_ATTEMPTS = 3;

async function publishTarget(targetId: string, attemptsMade: number): Promise<void> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    include: {
      socialAccount: true,
      post: { include: { mediaAsset: true, client: true } },
    },
  });
  if (!target) return;
  // Idempotency: reschedules replace the job; stale fires must not double post.
  if (target.status !== "scheduled") return;
  if (target.scheduledAt && target.scheduledAt.getTime() - Date.now() > 60_000) return;

  await prisma.postTarget.update({
    where: { id: target.id },
    data: { status: "publishing" },
  });

  try {
    const caption = [
      target.caption ?? "",
      target.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" "),
    ]
      .filter(Boolean)
      .join("\n\n");

    const asset = target.post.mediaAsset;
    const targetOptions =
      (target.options as {
        instagram?: import("@toreroflow/publishers").InstagramScheduleOptions;
        youtube?: import("@toreroflow/publishers").YouTubeScheduleOptions;
        tiktok?: import("@toreroflow/publishers").TikTokScheduleOptions;
        youtubeTitle?: string;
        tiktokTitle?: string;
      } | null) ?? {};

    let remotePostId: string;
    let remoteUrl: string | undefined;

    const viaZernio =
      zernio && target.socialAccount.tokensEncrypted === "provider:zernio";
    if (viaZernio) {
      // Always the original upload; the app no longer produces re-encodes.
      const fileKey = asset?.storageKey;
      if (!fileKey) throw new Error("no media file for post");

      /*
       * A carousel is a set of images, not a video, so it takes a different
       * road to the provider: every slide is uploaded in order, because the
       * first one decides the aspect ratio of the whole post and the rest
       * follow it.
       *
       * Uploaded fresh each publish rather than cached by key, for the same
       * reason covers are: a re-picked image overwrites the same path, and a
       * path-keyed cache would post the old one.
       */
      const slideKeys = Array.isArray(asset?.slideKeys) ? (asset.slideKeys as string[]) : [];
      const isCarousel = asset?.kind === "carousel" && slideKeys.length > 0;
      // Each slide carries its own type: a video slide declared an image is
      // refused by the platform at publish, hours after the operator left.
      const slideItems = isCarousel
        ? await Promise.all(
            slideKeys.map(async (key) => ({
              url: await zernioSlideUrl(key),
              type: /\.(mp4|mov)$/i.test(key) ? ("video" as const) : ("image" as const),
            })),
          )
        : undefined;

      const mediaUrl = isCarousel
        ? undefined
        : await zernioMediaUrl(asset!.id, path.join(env.STORAGE_DIR, fileKey));
      const coverUrl = asset?.coverKey ? await zernioImageUrl(asset.coverKey) : null;
      const extras = buildPostExtras({
        platform: target.platform as Platform,
        format: asset?.format ?? null,
        coverUrl,
        carousel: isCarousel,
        caption,
        instagram: targetOptions.instagram ?? null,
        youtube: targetOptions.youtube ?? null,
        tiktok: targetOptions.tiktok ?? null,
        youtubeTitle: targetOptions.youtubeTitle ?? null,
        tiktokTitle: targetOptions.tiktokTitle ?? null,
      });
      const result = await zernio.createPost({
        // A TikTok photo post reads content as its title; the builder moves
        // the caption into tiktokSettings.description and says so here.
        content: extras.contentOverride ?? caption,
        mediaUrl,
        slideItems,
        mediaThumbnail: extras.mediaThumbnail,
        targets: [
          {
            platform: target.platform as Platform,
            accountId: target.socialAccount.providerAccountId ?? "",
            platformSpecificData: extras.platformSpecificData,
          },
        ],
        tiktokSettings: extras.tiktokSettings,
        publishNow: true,
      });
      remotePostId = result.remotePostId;
    } else {
      // Dry-run accounts (and dev without a provider key) log instead of post.
      const publisher = new DryRunPublisher(target.platform as Platform);
      const drySlides = Array.isArray(asset?.slideKeys) ? (asset.slideKeys as string[]) : [];
      const extras = buildPostExtras({
        platform: target.platform as Platform,
        format: asset?.format ?? null,
        coverUrl: asset?.coverKey ? `/files/${asset.coverKey}` : null,
        carousel: asset?.kind === "carousel" && drySlides.length > 0,
        caption,
        instagram: targetOptions.instagram ?? null,
        youtube: targetOptions.youtube ?? null,
        tiktok: targetOptions.tiktok ?? null,
        youtubeTitle: targetOptions.youtubeTitle ?? null,
        tiktokTitle: targetOptions.tiktokTitle ?? null,
      });
      const result = await publisher.publish({
        account: {
          id: target.socialAccount.id,
          platform: target.platform as Platform,
          handle: target.socialAccount.handle,
        },
        videoUrl: asset?.storageKey ?? "",
        caption,
        hashtags: target.hashtags,
        extras,
      });
      remotePostId = result.remotePostId;
      remoteUrl = result.remoteUrl;
    }

    await prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: "posted",
        remotePostId,
        remoteUrl,
        publishedAt: new Date(),
        error: null,
      },
    });
    const siblings = await prisma.postTarget.findMany({
      where: { postId: target.postId },
    });
    if (siblings.every((s) => s.status === "posted")) {
      await prisma.post.update({
        where: { id: target.postId },
        data: { status: "posted" },
      });
    }
    console.log(`[worker] target ${target.id} posted (${target.platform})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finalAttempt = attemptsMade + 1 >= PUBLISH_ATTEMPTS;
    await prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: finalAttempt ? "failed" : "scheduled",
        error: message.slice(0, 500),
      },
    });
    if (finalAttempt) {
      await prisma.post.update({
        where: { id: target.postId },
        data: { status: "failed" },
      });
    }
    console.error(`[worker] target ${target.id} attempt ${attemptsMade + 1} failed: ${message}`);
    throw error; // throwing is what marks it failed and triggers the retry
  }
}

/* ---- daily analytics ingestion (spec Section 5 step 4) ---- */

/** First numeric value among several possible provider field names. */
function metric(item: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const v = item[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

interface DayBucket {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  posts: number;
  watchSum: number;
  watchCount: number;
}

/**
 * Zernio's /analytics returns posts (including pre-existing platform content)
 * with per-platform entries carrying accountId, metrics, and publish dates.
 * We attribute each post's metrics to its publish day, giving instant
 * backfilled history the moment an account connects.
 * The pull is the full windowed history, and every post lands in the external
 * store before the 200-day horizon trims anything.
 */
async function ingestAnalytics(): Promise<void> {
  if (!zernio) return;
  const accounts = await prisma.socialAccount.findMany({
    where: {
      deletedAt: null,
      status: "connected",
      tokensEncrypted: "provider:zernio",
    },
  });
  if (!accounts.length) {
    console.log("[worker] analytics: no provider-connected accounts yet");
    return;
  }

  let posts: Array<Record<string, unknown>> = [];
  let remoteAccounts: Awaited<ReturnType<typeof zernio.listAccounts>> = [];
  try {
    [posts, remoteAccounts] = await Promise.all([
      zernio.analyticsHistory(),
      zernio.listAccounts(),
    ]);
  } catch (error) {
    console.error("[worker] analytics pull failed:", error);
    return;
  }

  // The rolling store: every provider post persists before the horizon
  // trim below, so all-time boards outlive Zernio's one-year window. The
  // 200-day horizon only concerns MetricSnapshot day-bucketing.
  const byProviderId = new Map(
    accounts
      .filter((a) => a.providerAccountId)
      .map((a) => [
        a.providerAccountId as string,
        { socialAccountId: a.id, platform: a.platform },
      ]),
  );
  try {
    const written = await persistProviderPosts(prisma, posts, byProviderId);
    console.log(`[worker] provider history persisted: ${written} rows`);
  } catch (error) {
    console.error("[worker] provider history persist failed:", error);
  }

  const horizon = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  const byAccount = new Map<string, Map<string, DayBucket>>();
  const postEntries: Array<{ accountId: string; postId: string; m: Record<string, unknown> }> = [];

  for (const post of posts) {
    const publishedAt = new Date(String(post.publishedAt ?? post.scheduledFor ?? ""));
    if (Number.isNaN(publishedAt.getTime()) || publishedAt < horizon) continue;
    const platforms = Array.isArray(post.platforms) ? post.platforms : [];
    for (const entry of platforms as Array<Record<string, unknown>>) {
      const accountId = typeof entry.accountId === "string" ? entry.accountId : null;
      const m = (entry.analytics ?? post.analytics) as Record<string, unknown> | undefined;
      if (!accountId || !m) continue;

      const dayKey = publishedAt.toISOString().slice(0, 10);
      let days = byAccount.get(accountId);
      if (!days) {
        days = new Map();
        byAccount.set(accountId, days);
      }
      let bucket = days.get(dayKey);
      if (!bucket) {
        bucket = { views: 0, reach: 0, likes: 0, comments: 0, shares: 0, posts: 0, watchSum: 0, watchCount: 0 };
        days.set(dayKey, bucket);
      }
      bucket.views += metric(m, "views", "impressions", "plays") ?? 0;
      bucket.reach += metric(m, "reach", "uniqueViews") ?? 0;
      bucket.likes += metric(m, "likes", "likeCount") ?? 0;
      bucket.comments += metric(m, "comments", "commentCount") ?? 0;
      bucket.shares += metric(m, "shares", "shareCount") ?? 0;
      bucket.posts += 1;
      // igReelsAvgWatchTime is reported in milliseconds; the others in seconds.
      const watchMs = metric(m, "igReelsAvgWatchTime");
      const watchSec =
        watchMs && watchMs > 0
          ? watchMs / 1000
          : metric(m, "avgWatchTime", "averageViewDuration");
      if (watchSec && watchSec > 0) {
        bucket.watchSum += watchSec;
        bucket.watchCount += 1;
      }

      const postId = post._id ?? post.id;
      if (typeof postId === "string") {
        postEntries.push({ accountId, postId, m });
      }
    }
  }

  const todayKey = new Date().toISOString().slice(0, 10);

  for (const account of accounts) {
    if (!account.providerAccountId) continue;
    const days = byAccount.get(account.providerAccountId) ?? new Map<string, DayBucket>();

    // Refresh followers, avatar, and display name from the accounts list.
    const remote = remoteAccounts.find((r) => r._id === account.providerAccountId);
    if (remote) {
      const profileData = remote.metadata?.profileData;
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: {
          avatarUrl: profileData?.profilePicture ?? account.avatarUrl,
          displayName:
            remote.displayName ?? profileData?.displayName ?? account.displayName,
        },
      });
    }

    for (const [dayKey, bucket] of days) {
      const capturedAt = new Date(`${dayKey}T12:00:00.000Z`);
      const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
      const dayEnd = new Date(`${dayKey}T23:59:59.999Z`);
      const engagementRate =
        bucket.views > 0 ? ((bucket.likes + bucket.comments) / bucket.views) * 100 : null;
      const avgWatchSec = bucket.watchCount ? bucket.watchSum / bucket.watchCount : null;
      const followers =
        dayKey === todayKey && typeof remote?.followersCount === "number"
          ? remote.followersCount
          : undefined;
      const data = {
        views: bucket.views,
        reach: bucket.reach,
        engagementRate,
        avgWatchSec,
        ...(followers !== undefined ? { followers } : {}),
        raw: {
          likes: bucket.likes,
          comments: bucket.comments,
          shares: bucket.shares,
          posts: bucket.posts,
        } as unknown as Prisma.InputJsonValue,
      };
      const existing = await prisma.metricSnapshot.findFirst({
        where: {
          socialAccountId: account.id,
          capturedAt: { gte: dayStart, lte: dayEnd },
        },
      });
      if (existing) {
        await prisma.metricSnapshot.update({ where: { id: existing.id }, data });
      } else {
        await prisma.metricSnapshot.create({
          data: { socialAccountId: account.id, capturedAt, ...data },
        });
      }
    }

    // Today's followers even when no content was published today.
    if (!days.has(todayKey) && typeof remote?.followersCount === "number") {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const existing = await prisma.metricSnapshot.findFirst({
        where: { socialAccountId: account.id, capturedAt: { gte: dayStart } },
      });
      if (existing) {
        await prisma.metricSnapshot.update({
          where: { id: existing.id },
          data: { followers: remote.followersCount },
        });
      } else {
        await prisma.metricSnapshot.create({
          data: {
            socialAccountId: account.id,
            capturedAt: new Date(),
            followers: remote.followersCount,
          },
        });
      }
    }

    // Per-post metrics for anything we published through the provider.
    const targets = await prisma.postTarget.findMany({
      where: { socialAccountId: account.id, status: "posted", remotePostId: { not: null } },
    });
    for (const target of targets) {
      const entry = postEntries.find(
        (p) => p.accountId === account.providerAccountId && p.postId === target.remotePostId,
      );
      if (!entry) continue;
      await prisma.postMetric.create({
        data: {
          postTargetId: target.id,
          capturedAt: new Date(),
          views: metric(entry.m, "views", "impressions", "plays"),
          likes: metric(entry.m, "likes", "likeCount"),
          comments: metric(entry.m, "comments", "commentCount"),
          shares: metric(entry.m, "shares", "shareCount"),
          saves: metric(entry.m, "saves", "saveCount"),
        },
      });
    }
  }
  console.log(
    `[worker] analytics ingested: ${accounts.length} accounts, ${posts.length} posts scanned`,
  );
}

void work<{ assetId: string }>("media", { concurrency: 1 }, async ({ assetId }) => {
  await processAsset(assetId);
});

// retryCount is what attemptsMade used to be: how many times this job has
// already failed, 0 on the first run. publishTarget decides from it whether a
// failure is the last one and the post is marked failed for good.
void work<{ targetId: string }>(
  "publish",
  { concurrency: 2 },
  async ({ targetId }, { retryCount }) => {
    await publishTarget(targetId, retryCount);
  },
);

// One at a time: these are model calls plus a headless browser print, and
// the operator is asking about one brand at a time anyway.
// One at a time: every run spends real money against a prepaid wallet, and
// research is something the operator watches rather than fires and forgets.
// One at a time: this reads a real bank and there is exactly one of them.
void work<{ connectionId?: string }>("bank", { concurrency: 1 }, async ({ connectionId }) => {
  if (connectionId) await syncBankConnection(connectionId);
  else await syncAllBanks();
});
/*
 * Once a day, unprompted.
 *
 * Without this the balance on the Financials screen only moved when somebody
 * pressed a button, so a figure last pulled a fortnight ago sat there looking
 * exactly like a figure pulled this morning. SimpleFIN refreshes the
 * underlying data once every 24 hours and allows roughly 24 reads in that
 * time, so daily is both as fresh as the data gets and nowhere near the limit.
 */
// A fixed hour rather than "every 24 hours from whenever this last restarted",
// which is what the old scheduler meant and which drifted with every deploy.
void scheduleCron("bank", "0 3 * * *");

/*
 * Re-queue what the calendar says is still coming.
 *
 * The queue and the database are two records of the same promise, and only one
 * of them is backed up. Moving the queue store from Redis to Postgres would
 * otherwise have dropped every delayed publish job that existed at that moment:
 * the card would still read "scheduled", the time would pass, and nothing would
 * post. The database is the copy that survives, so it is the copy that wins.
 *
 * Keyed on the target id, the same key the scheduling route uses, so a job that
 * is already queued is moved to the time it already had and nothing is
 * duplicated. That is what makes this safe on every boot rather than a one-off
 * script somebody has to remember on the day of a migration.
 *
 * Future times only. A target whose moment passed while nothing was queued is
 * left alone on purpose: publishing a client's video days late is a worse
 * outcome than not publishing it, and either way it is visible on the calendar.
 */
void (async () => {
  try {
    const coming = await prisma.postTarget.findMany({
      where: { status: "scheduled", scheduledAt: { gt: new Date() } },
      select: { id: true, scheduledAt: true },
    });
    for (const target of coming) {
      await reschedule("publish", { targetId: target.id }, target.id, target.scheduledAt!);
    }
    if (coming.length) console.log(`[worker] re-queued ${coming.length} scheduled posts`);
  } catch (err) {
    console.error("[worker] could not re-queue scheduled posts:", err);
  }
})();

/*
 * The State filing deadline, checked once a day.
 *
 * On its own timer rather than inside the bank job because it has nothing to
 * do with banks: it must keep running for an operator whose bank is
 * disconnected, and a bank sync failing must not take the year's only
 * statutory deadline down with it. It says nothing on 360 days of the year.
 */
void (async () => {
  await checkFilingReminders();
})();
setInterval(
  () => {
    void checkFilingReminders();
  },
  6 * 60 * 60 * 1000,
);

void work<{ runId: string }>("research", { concurrency: 1 }, async ({ runId }) => {
  await runResearch(runId);
});

void work<{ clientId: string }>("insights", { concurrency: 1 }, async ({ clientId }) => {
  await generateInsight(clientId);
});

// One at a time, all three: each is ffmpeg or whisper on the same disk, and
// two concurrent encodes finish later than two queued ones. The one queue
// carries both jobs: asset processing (the default) and full renders.
void work<{ editAssetId?: string; editProjectId?: string; job?: string; mode?: string }>(
  "edit",
  { concurrency: 1 },
  async (data) => {
    if (data.job === "render" && data.editProjectId) {
      await renderProject(data.editProjectId);
    } else if (data.job === "isolate" && data.editAssetId) {
      await isolateVoice(data.editAssetId, data.mode === "instrumental" ? "instrumental" : "voice");
    } else if (data.editAssetId) {
      await processEditAsset(data.editAssetId);
    }
  },
);

void work<{ analysisId: string }>("analyze", { concurrency: 1 }, async ({ analysisId }) => {
  await runAnalysis(analysisId);
});

void work<{ knowledgeFileId: string }>(
  "knowledge",
  { concurrency: 1 },
  async ({ knowledgeFileId }) => {
    await extractKnowledgeFile(knowledgeFileId);
  },
);

void work(
  "analytics",
  { concurrency: 1 },
  async () => {
    await ingestAnalytics();
    // Lifetime view counts keep climbing, so refresh them on the same beat.
    await refreshYouTubeCatalogues();
    // Checked daily, deletes on the week: a video posted the day after a
    // weekly sweep would otherwise sit for a fortnight, and "a week" should
    // mean a week rather than somewhere between one and two.
    await sweepPostedSources();
    // The same daily beat on a longer clock. Runs second because it is the
    // smaller job by far, and a failure here must not stop the source sweep
    // that actually keeps the disk down.
    await sweepPostedThumbnails();
  },
);
// Daily schedule plus one catch-up pull on boot (same-day dedupe inside).
// An hour after the bank sync so two heavy jobs are not started together.
void scheduleCron("analytics", "0 4 * * *");
void (async () => {
  await ingestAnalytics();
  await refreshYouTubeCatalogues();
})();

/*
 * A heartbeat, so the app can say when this process is not running.
 *
 * Without it a dead worker is invisible: an upload is accepted, its job goes
 * on the queue, and the card sits at "Queued for processing" forever with
 * nothing anywhere saying why. That is exactly what happened, and the videos
 * looked like the broken thing when the worker was the broken thing.
 *
 * A timestamp that has to be refreshed rather than a flag, because a worker
 * that is killed cannot clear a flag on the way out, and a stale "running" is
 * worse than no signal. This was a Redis key with a TTL, which expired by
 * itself; Postgres has none, so the reader judges it by age instead and the
 * guarantee is the same.
 */
const HEARTBEAT_SECONDS = 30;

const beat = () => {
  const beatAt = new Date();
  void prisma.workerHeartbeat
    .upsert({
      where: { id: "worker" },
      create: { id: "worker", beatAt },
      update: { beatAt },
    })
    // Never throw out of a timer: an unhandled rejection here would take down
    // the process this is supposed to be reporting on.
    .catch((err: unknown) => console.error("[worker] heartbeat failed:", err));
};
beat();
setInterval(beat, HEARTBEAT_SECONDS * 1000).unref();

console.log(
  `[toreroflow-worker] queues: media, publish, analytics, insights, research, bank, edit, analyze, knowledge (provider: ${zernio ? "zernio" : "dryrun"}, youtube: ${youtube ? "on" : "off"})`,
);
