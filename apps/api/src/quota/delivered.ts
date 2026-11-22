import type { getPrisma } from "@toreroflow/db";

/**
 * What a pay period's uploads count as, in one place.
 *
 * The quota card, Account Overview and Financials all ask "how much work went
 * out since the period started", and each used to count it on its own. Three
 * copies of one rule is three answers the moment one changes, and trial reels
 * changed it: a video that only ever goes out as an Instagram trial reel is its
 * own kind of work, never a short-form.
 */

export type QuotaBucket = "short" | "long" | "carousel" | "trial" | "unclassified";

export interface BucketCounts {
  uploads: number;
  revisions: number;
}

export type Delivered = Record<QuotaBucket, BucketCounts>;

type Target = { platform: string; options: unknown };

type IgOptions = { instagram?: { trial?: unknown; story?: unknown }; instagramFeedPost?: unknown } | null;

/**
 * An Instagram trial reel: shown to non-followers first. Never a story, and
 * never a reel retried plain (instagramFeedPost), which went to every follower.
 * The calendar's teal uses the same rule (routes/posts.ts).
 */
export function isTrialTarget(t: Target): boolean {
  const o = (t.options as IgOptions) ?? {};
  return t.platform === "instagram" && o.instagram?.trial === true && o.instagram.story !== true && o.instagramFeedPost !== true;
}

/** An Instagram story: the copy "Also to story" makes of the same reel, not a place of its own. */
const isStory = (t: Target) => t.platform === "instagram" && (t.options as IgOptions)?.instagram?.story === true;

/**
 * Which counter one upload counts toward, or null for none.
 *
 * - A carousel is a carousel, whatever it was posted as.
 * - A video counts as a trial reel when every place it is scheduled is an
 *   Instagram trial reel. Also sent to TikTok, YouTube or a normal post, it is
 *   short- or long-form work like any other.
 * - A Drive auto-post video not scheduled yet (still processing, or held) is
 *   not delivered work, so it counts as nothing until it goes on the calendar.
 * - Otherwise by format; a video still being probed has none yet.
 */
export function quotaBucket(a: { kind: string; format: string | null; targets: Target[]; fromDrive: boolean }): QuotaBucket | null {
  if (a.kind === "carousel") return "carousel";
  if (a.kind !== "video") return null;
  // The story copy of a trial reel does not make it a short.
  const placed = a.targets.filter((t) => !isStory(t));
  if (placed.length > 0 && placed.every(isTrialTarget)) return "trial";
  if (a.targets.length === 0 && a.fromDrive) return null;
  if (a.format === "short_form") return "short";
  if (a.format === "long_form") return "long";
  return a.format === null ? "unclassified" : null;
}

/** Uploads and revisions per counter, for one client since `since`. */
export async function countDelivered(
  prisma: ReturnType<typeof getPrisma>,
  clientId: string,
  since: Date,
): Promise<Delivered> {
  const assets = await prisma.mediaAsset.findMany({
    where: { clientId, createdAt: { gte: since } },
    select: { id: true, kind: true, format: true, isRevision: true },
  });
  const out: Delivered = {
    short: { uploads: 0, revisions: 0 },
    long: { uploads: 0, revisions: 0 },
    carousel: { uploads: 0, revisions: 0 },
    trial: { uploads: 0, revisions: 0 },
    unclassified: { uploads: 0, revisions: 0 },
  };
  if (!assets.length) return out;

  const ids = assets.map((a) => a.id);
  const [posts, drive] = await Promise.all([
    // A draft is not scheduled anywhere yet, so it says nothing about what the video is.
    prisma.post.findMany({
      where: { mediaAssetId: { in: ids }, deletedAt: null, status: { not: "draft" } },
      select: { mediaAssetId: true, targets: { select: { platform: true, options: true } } },
    }),
    prisma.driveImport.findMany({ where: { clientId, assetId: { in: ids } }, select: { assetId: true } }),
  ]);
  const targets = new Map<string, Target[]>();
  for (const p of posts) {
    if (!p.mediaAssetId) continue;
    targets.set(p.mediaAssetId, [...(targets.get(p.mediaAssetId) ?? []), ...p.targets]);
  }
  const fromDrive = new Set(drive.map((d) => d.assetId));

  for (const a of assets) {
    const bucket = quotaBucket({
      kind: a.kind,
      format: a.format,
      targets: targets.get(a.id) ?? [],
      fromDrive: fromDrive.has(a.id),
    });
    if (bucket) out[bucket][a.isRevision ? "revisions" : "uploads"] += 1;
  }
  return out;
}
