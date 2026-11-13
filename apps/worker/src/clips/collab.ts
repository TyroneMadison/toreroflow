import fs from "node:fs/promises";
import { constants as fsc } from "node:fs";
import path from "node:path";
import { Prisma, enqueue, getPrisma } from "@toreroflow/db";
import {
  aggregatePerformance,
  newUploads,
  readAutoImport,
  watchedPlaylists,
  type FeedVideo,
  type PerfSample,
  type RecipeSettings,
} from "@toreroflow/core";
import { env } from "../env";

/**
 * Phase 8 worker side: YouTube auto-import from the client's own channel
 * and per-clip performance pulled back onto ClipCandidate.
 *
 * ponytail: the YouTube Data API lists videos but cannot hand over the
 * file, and a generic downloader is out of scope (FEATURES). So a new
 * upload becomes a ClipJob only when the same video was published
 * through Toreroflow: its PostTarget.remotePostId names the stored
 * MediaAsset, which is the source. Anything else is recorded "skipped"
 * with the reason, visible in the Imports panel.
 */

const prisma = getPrisma();
const YT_BASE = () => process.env.YOUTUBE_API_BASE || "https://www.googleapis.com/youtube/v3";

async function playlistFeed(playlistId: string): Promise<FeedVideo[]> {
  const u = new URL(`${YT_BASE()}/playlistItems`);
  u.searchParams.set("part", "snippet,contentDetails");
  u.searchParams.set("playlistId", playlistId);
  u.searchParams.set("maxResults", "25");
  u.searchParams.set("key", env.YOUTUBE_API_KEY);
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`YouTube answered ${res.status} for playlist ${playlistId}`);
  const data = (await res.json()) as {
    items?: { snippet?: { title?: string; publishedAt?: string }; contentDetails?: { videoId?: string; videoPublishedAt?: string } }[];
  };
  return (data.items ?? [])
    .filter((i) => i.contentDetails?.videoId)
    .map((i) => ({
      videoId: i.contentDetails!.videoId!,
      title: (i.snippet?.title ?? "").slice(0, 200) || "Untitled",
      publishedAt: i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt ?? null,
    }));
}

/** Copy a stored upload into a holder project and queue a clip job (mirrors POST /clip-jobs/from-asset). */
async function startJobFromMedia(clientId: string, ma: { id: string; originalName: string; storageKey: string }, recipeId: string | null) {
  const recipe = recipeId
    ? await prisma.recipe.findFirst({ where: { id: recipeId, clientId } })
    : await prisma.recipe.findFirst({ where: { clientId, isDefault: true } });
  const aspect = (recipe?.settings as RecipeSettings | undefined)?.aspect ?? "9:16";
  const project = await prisma.editProject.create({
    data: { clientId, name: `Clips source: ${ma.originalName}`.slice(0, 200), status: "clipsource" },
  });
  const asset = await prisma.editAsset.create({
    data: { projectId: project.id, kind: "clip", storageKey: "pending", originalName: ma.originalName, status: "uploaded" },
  });
  const storageKey = `${clientId}/edit/${project.id}/${asset.id}-source${path.extname(ma.originalName) || ".mp4"}`;
  await fs.mkdir(path.join(env.STORAGE_DIR, clientId, "edit", project.id), { recursive: true });
  try {
    await fs.copyFile(path.join(env.STORAGE_DIR, ma.storageKey), path.join(env.STORAGE_DIR, storageKey), fsc.COPYFILE_FICLONE);
  } catch {
    await prisma.editProject.delete({ where: { id: project.id } });
    return null;
  }
  await prisma.editAsset.update({ where: { id: asset.id }, data: { storageKey } });
  const options = {
    length: "auto", aspect, reframe: true, ...(recipe ? { recipeId: recipe.id } : {}),
    log: [{ at: new Date().toISOString(), line: "auto-imported from YouTube" }],
  };
  const job = await prisma.clipJob.create({
    data: { clientId, sourceAssetId: asset.id, options: options as unknown as Prisma.InputJsonValue, stage: "queued" },
  });
  await enqueue("clips", { clipJobId: job.id, stage: "analyze" });
  return job.id;
}

export async function runAutoImport(clientId: string, force = false): Promise<string> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { autoImport: true } });
  if (!client) return "no client";
  const s = readAutoImport(client.autoImport);
  const save = (lastResult: string) =>
    prisma.client.update({
      where: { id: clientId },
      data: { autoImport: { ...s, lastCheckAt: new Date().toISOString(), lastResult } as unknown as Prisma.InputJsonValue },
    });
  if (!s.on && !force) return "off";
  if (!env.YOUTUBE_API_KEY) {
    await save("YouTube key missing: add YOUTUBE_API_KEY to read the channel.");
    return "no key";
  }
  const lists = watchedPlaylists(s);
  if (!lists.length) {
    await save("Add a channel id or a playlist to watch.");
    return "nothing to watch";
  }
  let feed: FeedVideo[] = [];
  try {
    for (const p of lists) feed = feed.concat(await playlistFeed(p));
  } catch (e) {
    await save(e instanceof Error ? e.message : "YouTube check failed");
    return "failed";
  }
  const seen = new Set((await prisma.youTubeImport.findMany({ where: { clientId }, select: { videoId: true } })).map((r) => r.videoId));
  // First run: only videos published after the settings were saved (lastCheckAt).
  const fresh = newUploads(feed, seen, s.lastCheckAt, seen.size === 0);
  let imported = 0;
  let skipped = 0;
  for (const v of fresh) {
    const target = await prisma.postTarget.findFirst({
      where: { platform: "youtube", remotePostId: v.videoId, post: { clientId, mediaAssetId: { not: null } } },
      include: { post: { include: { mediaAsset: true } } },
    });
    const ma = target?.post.mediaAsset;
    let jobId: string | null = null;
    let reason: string | null = null;
    if (!ma) reason = "Not posted through Toreroflow, so there is no file to clip. Upload it to start a clip job.";
    else if (ma.sourceDeletedAt) reason = "The stored file was removed by retention.";
    else {
      jobId = await startJobFromMedia(clientId, ma, s.recipeId);
      if (!jobId) reason = "The stored file is no longer on the server.";
    }
    await prisma.youTubeImport.upsert({
      where: { clientId_videoId: { clientId, videoId: v.videoId } },
      create: {
        clientId, videoId: v.videoId, title: v.title, publishedAt: v.publishedAt ? new Date(v.publishedAt) : null,
        status: jobId ? "imported" : "skipped", reason, clipJobId: jobId,
      },
      update: {},
    });
    if (jobId) {
      imported++;
      await prisma.clipActivity.create({ data: { clientId, actor: "Auto-import", action: "imported", jobId, detail: v.title } });
    } else skipped++;
  }
  // Remember every listed video so old ones never import later.
  for (const v of feed) {
    if (seen.has(v.videoId) || fresh.some((f) => f.videoId === v.videoId)) continue;
    seen.add(v.videoId);
    await prisma.youTubeImport.upsert({
      where: { clientId_videoId: { clientId, videoId: v.videoId } },
      create: { clientId, videoId: v.videoId, title: v.title, publishedAt: v.publishedAt ? new Date(v.publishedAt) : null, status: "skipped", reason: "Published before auto-import was on." },
      update: {},
    });
  }
  const line = `${fresh.length} new: ${imported} imported, ${skipped} skipped.`;
  await save(line);
  return line;
}

export async function autoImportAll(): Promise<void> {
  const clients = await prisma.client.findMany({ where: { deletedAt: null, autoImport: { not: Prisma.DbNull } }, select: { id: true, autoImport: true } });
  for (const c of clients) {
    if (!readAutoImport(c.autoImport).on) continue;
    await runAutoImport(c.id).catch((e: unknown) => console.error("[auto-import]", c.id, e));
  }
}

/**
 * Per-clip performance: candidate -> opened project -> the upload it was
 * sent to -> its posts -> latest PostMetric per target, with average watch
 * time from the synced ExternalVideo row when the platform gives one.
 */
export async function syncClipPerf(clientId: string): Promise<number> {
  const cands = await prisma.clipCandidate.findMany({
    where: { job: { clientId }, editProjectId: { not: null } },
    select: { id: true, duration: true, editProjectId: true },
  });
  let n = 0;
  for (const c of cands) {
    const proj = await prisma.editProject.findUnique({ where: { id: c.editProjectId! }, select: { uploadAssetId: true } });
    if (!proj?.uploadAssetId) continue;
    const targets = await prisma.postTarget.findMany({
      where: { post: { mediaAssetId: proj.uploadAssetId, deletedAt: null }, status: "posted" },
      include: { postMetrics: { orderBy: { capturedAt: "desc" }, take: 1 } },
    });
    if (!targets.length) continue;
    const samples: PerfSample[] = [];
    for (const t of targets) {
      const m = t.postMetrics[0];
      const ext = t.remotePostId
        ? await prisma.externalVideo.findFirst({ where: { socialAccountId: t.socialAccountId, platformVideoId: t.remotePostId } })
        : null;
      if (!m && !ext) continue;
      samples.push({
        platform: t.platform,
        views: Math.max(m?.views ?? 0, ext?.views ?? 0),
        likes: Math.max(m?.likes ?? 0, ext?.likes ?? 0),
        comments: Math.max(m?.comments ?? 0, ext?.comments ?? 0),
        shares: Math.max(m?.shares ?? 0, ext?.shares ?? 0),
        saves: Math.max(m?.saves ?? 0, ext?.saves ?? 0),
        avgWatchSec: ext?.avgWatchSec ?? null,
      });
    }
    if (!samples.length) continue;
    const perf = aggregatePerformance(samples, c.duration);
    await prisma.clipCandidate.update({ where: { id: c.id }, data: { perf: perf as unknown as Prisma.InputJsonValue, perfAt: new Date() } });
    n++;
  }
  return n;
}

export async function syncAllClipPerf(): Promise<void> {
  const clients = await prisma.clipJob.findMany({ distinct: ["clientId"], select: { clientId: true } });
  for (const c of clients) await syncClipPerf(c.clientId).catch((e: unknown) => console.error("[clip-perf]", c.clientId, e));
}
