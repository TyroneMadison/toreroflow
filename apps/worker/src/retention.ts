import path from "node:path";
import fs from "node:fs/promises";
import { sourceRetention } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "./env";

/** The images a video accumulates: the auto thumbnail and either cover. */
const IMAGE_NAMES = ["thumb.jpg", "cover.jpg", "cover.png"] as const;

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
      kind: { in: ["video", "carousel"] },
      sourceDeletedAt: null,
      // A video nobody has posted anywhere cannot be past its window, so it is
      // not worth loading. Drafts and failures never reach this query.
      posts: { some: { targets: { some: { status: "posted" } } } },
    },
    select: {
      id: true,
      kind: true,
      storageKey: true,
      slideKeys: true,
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

    /*
     * What "the source" means depends on what the asset is. A video is one
     * file. A carousel is its slides, all but the first: the first slide
     * doubles as the thumbnail every card draws, so it lives on the image
     * clock and goes with the 30-day sweep below instead.
     */
    const slides = Array.isArray(asset.slideKeys) ? (asset.slideKeys as string[]) : [];
    const keys =
      asset.kind === "carousel" ? slides.filter((k) => k !== asset.storageKey) : [asset.storageKey];

    let failed = false;
    for (const key of keys) {
      const abs = path.join(env.STORAGE_DIR, key);
      try {
        const stat = await fs.stat(abs);
        await fs.rm(abs, { force: true });
        freedBytes += stat.size;
      } catch (err) {
        // Already gone is the goal, not a failure: mark it and move on so the
        // sweep does not keep looking at the same row every day forever.
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          console.error(`[worker] retention could not clear ${key}:`, err);
          failed = true;
          break;
        }
      }
    }
    if (failed) {
      skipped += 1;
      continue;
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

/**
 * Clear the thumbnail and cover of videos that went live a month ago.
 *
 * Same rule as the source, on a longer clock, so it reuses the same verdict
 * rather than growing a second opinion about when a post is finished.
 *
 * Worth being clear about what this costs, because it is not free and it is
 * not reversible. The images are tiny next to the video, roughly a
 * five-hundredth of it, so this is not what keeps a disk small. What it does
 * is stop them accumulating forever. The price is that a calendar card older
 * than the window loses its picture: it keeps its title, platform, status and
 * time, and the queue falls back to its gradient. Nothing 404s, because the
 * row is marked and the API then hands out no link at all.
 *
 * It cannot be undone. The frame is cut from the source, and the source went
 * three weeks earlier, so there is nothing left to cut it from again.
 */
export async function sweepPostedThumbnails(now = new Date()): Promise<SweepResult> {
  const assets = await prisma.mediaAsset.findMany({
    where: {
      kind: { in: ["video", "carousel"] },
      thumbDeletedAt: null,
      posts: { some: { targets: { some: { status: "posted" } } } },
    },
    select: {
      id: true,
      kind: true,
      clientId: true,
      storageKey: true,
      originalName: true,
      posts: { select: { targets: { select: { status: true, publishedAt: true } } } },
    },
  });

  let deleted = 0;
  let freedBytes = 0;
  let skipped = 0;

  for (const asset of assets) {
    const targets = asset.posts.flatMap((p) => p.targets);
    const verdict = sourceRetention(targets, now, env.THUMB_RETENTION_DAYS);
    if (!verdict.deletable) {
      skipped += 1;
      continue;
    }

    // Every image the asset may have. A video has a thumbnail and at most one
    // cover; a carousel's one remaining image is its first slide, kept back by
    // the source sweep because it doubles as the thumbnail. Most of these are
    // already absent, and that is not a failure.
    const names: string[] =
      asset.kind === "carousel"
        ? [asset.storageKey.split("/").pop() ?? ""]
        : [...IMAGE_NAMES];
    let removedAny = false;
    for (const name of names) {
      const abs = path.join(env.STORAGE_DIR, asset.clientId, asset.id, name);
      try {
        const stat = await fs.stat(abs);
        await fs.rm(abs, { force: true });
        freedBytes += stat.size;
        removedAny = true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          console.error(`[worker] retention could not clear ${abs}:`, err);
        }
      }
    }

    // Marked either way. A row whose files were already gone is finished with,
    // and leaving it unmarked would have the sweep reconsider it every day
    // forever.
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { thumbDeletedAt: now },
    });
    deleted += 1;
    if (removedAny) console.log(`[worker] retention cleared images for ${asset.originalName}`);
  }

  if (deleted || skipped) {
    console.log(
      `[worker] retention: images cleared for ${deleted} video(s), ${(freedBytes / 1024).toFixed(0)}KB freed, ${skipped} still inside the ${env.THUMB_RETENTION_DAYS} day window`,
    );
  }
  return { deleted, freedBytes, skipped };
}
