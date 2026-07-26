import path from "node:path";
import fs from "node:fs/promises";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import Anthropic from "@anthropic-ai/sdk";
import { decodeEscapes, formatFromDuration } from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { extractThumbnail, probe, type TranscriptSegment } from "@toreroflow/media";
import { env } from "./env";

const prisma = getPrisma();
const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "description", "hashtags"],
  additionalProperties: false,
} as const;

function cleanDraft(draft: unknown): unknown {
  if (!draft || typeof draft !== "object") return draft;
  const d = draft as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? decodeEscapes(v) : v);
  return {
    ...d,
    title: str(d.title),
    description: str(d.description),
    hashtags: Array.isArray(d.hashtags) ? d.hashtags.map((h) => str(h)) : d.hashtags,
  };
}

async function transcribe(sourcePath: string): Promise<{
  segments: TranscriptSegment[];
} | null> {
  try {
    const res = await fetch(`${env.CAPTIONS_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { segments: TranscriptSegment[] };
  } catch {
    return null; // captions service down: pipeline continues without captions
  }
}

async function draftCopy(
  clientName: string,
  transcriptText: string,
): Promise<unknown | null> {
  if (!anthropic || !transcriptText.trim()) return null;
  try {
    const response = await anthropic.messages.create({
      model: env.COPY_MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: DRAFT_SCHEMA },
      },
      system:
        "You write short-form video post copy for a social media agency. " +
        "Given a video transcript, produce: a title (this is used verbatim as " +
        "the YouTube title and as the Instagram and TikTok caption, so make it " +
        "punchy and under 100 characters, no hashtags inside), a description " +
        "(2-4 sentences describing the video for the post description, no " +
        "hashtags inside), and 5-8 relevant hashtags without the # sign. " +
        "Write emoji as real characters, never as escape sequences.",
      messages: [
        {
          role: "user",
          content: `Brand: ${clientName}\nTranscript:\n${transcriptText.slice(0, 4000)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    return text && text.type === "text" ? cleanDraft(JSON.parse(text.text)) : null;
  } catch {
    return null; // draft is a nice-to-have; never fail the pipeline for it
  }
}

async function processAsset(assetId: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: { client: true },
  });
  if (!asset) return;

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

    // 2. Transcribe (local faster-whisper service)
    const transcript = await transcribe(sourcePath);
    const segments = transcript?.segments ?? [];
    if (transcript) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { transcript: segments as unknown as Prisma.InputJsonValue },
      });
    }

    // 3. AI post copy draft (needs ANTHROPIC_API_KEY; skipped gracefully)
    const transcriptText = segments.map((s) => s.text).join(" ");
    const draft = await draftCopy(asset.client.name, transcriptText);
    if (draft) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { draftCopy: draft },
      });
    }

    // 4. Thumbnail from the source video itself.
    // The video is never re-encoded: it publishes exactly as exported, so
    // there is no reframe and no burned-in captions. The transcript above
    // exists to feed the title and description, nothing more.
    const thumbAt = Math.min(1, (meta.durationSec || 1) * 0.25);
    await extractThumbnail(sourcePath, path.join(assetDir, "thumb.jpg"), thumbAt);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "ready" },
    });
    console.log(`[worker] asset ${asset.id} ready (${segments.length} transcript segments)`);
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

import { DryRunPublisher, YouTubeProvider, ZernioProvider } from "@toreroflow/publishers";
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
        const data = {
          platform: "youtube" as const,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          publishedAt: new Date(v.publishedAt),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          durationSec: v.durationSec,
          fetchedAt: new Date(),
        };
        await prisma.externalVideo.upsert({
          where: {
            socialAccountId_platformVideoId: {
              socialAccountId: account.id,
              platformVideoId: v.platformVideoId,
            },
          },
          create: { socialAccountId: account.id, platformVideoId: v.platformVideoId, ...data },
          update: data,
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

    let remotePostId: string;
    let remoteUrl: string | undefined;

    const viaZernio =
      zernio && target.socialAccount.tokensEncrypted === "provider:zernio";
    if (viaZernio) {
      const asset = target.post.mediaAsset;
      // Always the original upload; the app no longer produces re-encodes.
      const fileKey = asset?.storageKey;
      if (!fileKey) throw new Error("no media file for post");
      const mediaUrl = await zernioMediaUrl(asset!.id, path.join(env.STORAGE_DIR, fileKey));
      const result = await zernio.createPost({
        content: caption,
        mediaUrl,
        targets: [
          {
            platform: target.platform as Platform,
            accountId: target.socialAccount.providerAccountId ?? "",
          },
        ],
        publishNow: true,
      });
      remotePostId = result.remotePostId;
    } else {
      // Dry-run accounts (and dev without a provider key) log instead of post.
      const publisher = new DryRunPublisher(target.platform as Platform);
      const result = await publisher.publish({
        account: {
          id: target.socialAccount.id,
          platform: target.platform as Platform,
          handle: target.socialAccount.handle,
        },
        videoUrl: target.post.mediaAsset?.storageKey ?? "",
        caption,
        hashtags: target.hashtags,
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
    throw error; // let BullMQ retry with backoff
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
      zernio.analytics(500),
      zernio.listAccounts(),
    ]);
  } catch (error) {
    console.error("[worker] analytics pull failed:", error);
    return;
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

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

new Worker<{ assetId: string }>(
  "media",
  async (job) => {
    await processAsset(job.data.assetId);
  },
  { connection, concurrency: 1 },
);

new Worker<{ targetId: string }>(
  "publish",
  async (job) => {
    await publishTarget(job.data.targetId, job.attemptsMade);
  },
  { connection, concurrency: 2 },
);

import { Queue } from "bullmq";

const analyticsQueue = new Queue("analytics", { connection });
new Worker(
  "analytics",
  async () => {
    await ingestAnalytics();
    // Lifetime view counts keep climbing, so refresh them on the same beat.
    await refreshYouTubeCatalogues();
  },
  { connection, concurrency: 1 },
);
// Daily schedule plus one catch-up pull on boot (same-day dedupe inside).
void analyticsQueue.upsertJobScheduler(
  "daily-analytics",
  { every: 24 * 60 * 60 * 1000 },
  { name: "ingest", data: {} },
);
void (async () => {
  await ingestAnalytics();
  await refreshYouTubeCatalogues();
})();

console.log(
  `[toreroflow-worker] queues: media, publish, analytics (provider: ${zernio ? "zernio" : "dryrun"}, youtube: ${youtube ? "on" : "off"})`,
);
