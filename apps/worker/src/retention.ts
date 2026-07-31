import path from "node:path";
import fs from "node:fs/promises";
import { sourceRetention } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "./env";

/**
 * Clear the source file of videos that went live a week ago.
 *
 * The original upload is 96% of what this app stores and nothing reads it once
 * the post is up: the platform holds the video, cards render from the
 * thumbnail, reports read numbers. Without this the disk grows by roughly a
 * gigabyte a fortnight forever.
 *
 * The week is not arbitrary. It is the window to notice a post did badly and
 * reschedule it somewhere else, or to re-upload after a takedown. Whether a
 * given asset is inside that window is decided by `sourceRetention` in core,
 * which is pure and has the awkward cases pinned in a check.
 *
 * Only the file goes. The row, the thumbnail and the cover stay, so the
 * calendar, the queue and every past report keep working.
 */

const prisma = getPrisma();

export interface SweepResult {
  deleted: number;
  freedBytes: number;
  skipped: number;
}

export async function sweepPostedSources(now = new Date()): Promise<SweepResult> {
  const assets = await prisma.mediaAsset.findMany({
    where: {
      kind: "video",
      sourceDeletedAt: null,
      // A video nobody has posted anywhere cannot be past its window, so it is
      // not worth loading. Drafts and failures never reach this query.
      posts: { some: { targets: { some: { status: "posted" } } } },
    },
    select: {
      id: true,
      storageKey: true,
      originalName: true,
      posts: { select: { targets: { select: { status: true, publishedAt: true } } } },
    },
  });

  let deleted = 0;
  let freedBytes = 0;
  let skipped = 0;

  for (const asset of assets) {
    // Every target of every post this asset was used in. An asset reused for a
    // second post has to satisfy both, or the file the second one still needs
    // would go with the first one's grace period.
    const targets = asset.posts.flatMap((p) => p.targets);
    const verdict = sourceRetention(targets, now, env.RETENTION_DAYS);
    if (!verdict.deletable) {
      skipped += 1;
      continue;
    }

    const abs = path.join(env.STORAGE_DIR, asset.storageKey);
    try {
      const stat = await fs.stat(abs);
      await fs.rm(abs, { force: true });
      freedBytes += stat.size;
    } catch (err) {
      // Already gone is the goal, not a failure: mark it and move on so the
      // sweep does not keep looking at the same row every day forever.
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        console.error(`[worker] retention could not clear ${asset.storageKey}:`, err);
        skipped += 1;
        continue;
      }
    }

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { sourceDeletedAt: now },
    });
    deleted += 1;
    console.log(`[worker] retention cleared ${asset.originalName}`);
  }

  if (deleted || skipped) {
    console.log(
      `[worker] retention: ${deleted} source file(s) cleared, ${(freedBytes / 1024 / 1024).toFixed(1)}MB freed, ${skipped} still inside the ${env.RETENTION_DAYS} day window`,
    );
  }
  return { deleted, freedBytes, skipped };
}
