import path from "node:path";
import fs from "node:fs/promises";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import Anthropic from "@anthropic-ai/sdk";
import { getPrisma, Prisma } from "@toreroflow/db";
import {
  buildAss,
  extractThumbnail,
  probe,
  renderVertical,
  type TranscriptSegment,
} from "@toreroflow/media";
import { env } from "./env";

const prisma = getPrisma();
const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string" },
    hook: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["caption", "hook", "hashtags"],
  additionalProperties: false,
} as const;

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
        "Given a video transcript, produce a scroll-stopping hook, a post caption " +
        "(1-3 sentences, no hashtags inside), and 5-8 relevant hashtags without the # sign.",
      messages: [
        {
          role: "user",
          content: `Brand: ${clientName}\nTranscript:\n${transcriptText.slice(0, 4000)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    return text && text.type === "text" ? JSON.parse(text.text) : null;
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
    // 1. Probe
    const meta = await probe(sourcePath);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
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

    // 4. Vertical render with burned captions (Bold pop)
    let assPath: string | undefined;
    if (segments.some((s) => s.text.trim())) {
      assPath = path.join(assetDir, "subs.ass");
      await fs.writeFile(assPath, buildAss(segments), "utf8");
    }
    const renderKey = `${asset.clientId}/${asset.id}/vertical.mp4`;
    await renderVertical(sourcePath, path.join(env.STORAGE_DIR, renderKey), assPath);
    const existingRender = await prisma.render.findFirst({
      where: { mediaAssetId: asset.id },
    });
    // One representative 9:16 render for now; per-platform encode profiles
    // fan out when the publishing engine lands.
    if (existingRender) {
      await prisma.render.update({
        where: { id: existingRender.id },
        data: { status: "ready", storageKey: renderKey, captionStyle: "bold_pop" },
      });
    } else {
      await prisma.render.create({
        data: {
          mediaAssetId: asset.id,
          platform: "instagram",
          aspect: "9:16",
          storageKey: renderKey,
          captionStyle: segments.length ? "bold_pop" : null,
          status: "ready",
        },
      });
    }

    // 5. Thumbnail from the source video itself
    const thumbAt = Math.min(1, (meta.durationSec || 1) * 0.25);
    await extractThumbnail(sourcePath, path.join(assetDir, "thumb.jpg"), thumbAt);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "ready" },
    });
    console.log(`[worker] asset ${asset.id} ready (${segments.length} caption segments)`);
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

import { DryRunPublisher, ZernioProvider } from "@toreroflow/publishers";
import type { Platform } from "@toreroflow/core";

const zernio =
  env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
    ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
    : null;

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
      post: { include: { mediaAsset: { include: { renders: true } }, client: true } },
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
      const render = asset?.renders.find((r) => r.status === "ready");
      const fileKey = render?.storageKey ?? asset?.storageKey;
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

function itemAccountId(item: Record<string, unknown>): string | null {
  const direct = item.accountId ?? item.account_id;
  if (typeof direct === "string") return direct;
  const nested = item.account;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object" && "_id" in nested) {
    const id = (nested as { _id: unknown })._id;
    if (typeof id === "string") return id;
  }
  return null;
}

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

  let items: Array<Record<string, unknown>> = [];
  try {
    items = await zernio.analytics();
  } catch (error) {
    console.error("[worker] analytics pull failed:", error);
    return;
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  for (const account of accounts) {
    const mine = items.filter((i) => itemAccountId(i) === account.providerAccountId);
    const sum = (...names: string[]) =>
      mine.reduce((s, i) => s + (metric(i, ...names) ?? 0), 0);

    const views = sum("views", "viewCount", "plays", "impressions");
    const reach = sum("reach", "uniqueViews", "accountsReached");
    const likes = sum("likes", "likeCount", "favorites");
    const comments = sum("comments", "commentCount");
    const followers = mine.length
      ? metric(mine[0]!, "followers", "followerCount", "subscriberCount")
      : null;
    const engagementRate = views > 0 ? ((likes + comments) / views) * 100 : null;

    const existing = await prisma.metricSnapshot.findFirst({
      where: { socialAccountId: account.id, capturedAt: { gte: dayStart } },
    });
    if (existing) {
      await prisma.metricSnapshot.update({
        where: { id: existing.id },
        data: {
          views,
          reach,
          followers,
          engagementRate,
          raw: mine as unknown as Prisma.InputJsonValue,
        },
      });
    } else {
      await prisma.metricSnapshot.create({
        data: {
          socialAccountId: account.id,
          capturedAt: new Date(),
          views,
          reach,
          followers,
          engagementRate,
          raw: mine as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // Per-post metrics for anything we published through the provider.
    const targets = await prisma.postTarget.findMany({
      where: { socialAccountId: account.id, status: "posted", remotePostId: { not: null } },
    });
    for (const target of targets) {
      const item = mine.find((i) => {
        const id = i._id ?? i.id ?? i.postId;
        return typeof id === "string" && id === target.remotePostId;
      });
      if (!item) continue;
      await prisma.postMetric.create({
        data: {
          postTargetId: target.id,
          capturedAt: new Date(),
          views: metric(item, "views", "viewCount", "plays"),
          likes: metric(item, "likes", "likeCount"),
          comments: metric(item, "comments", "commentCount"),
          shares: metric(item, "shares", "shareCount", "reposts"),
          saves: metric(item, "saves", "saveCount", "bookmarks"),
        },
      });
    }
  }
  console.log(`[worker] analytics ingested for ${accounts.length} accounts`);
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
  },
  { connection, concurrency: 1 },
);
// Daily schedule plus one catch-up pull on boot (same-day dedupe inside).
void analyticsQueue.upsertJobScheduler(
  "daily-analytics",
  { every: 24 * 60 * 60 * 1000 },
  { name: "ingest", data: {} },
);
void ingestAnalytics();

console.log(
  `[toreroflow-worker] queues: media, publish, analytics (provider: ${zernio ? "zernio" : "dryrun"})`,
);
