import type { ClientPost, Platform } from "./api";

/**
 * The view-tier boards on the Analytics screen.
 *
 * These rank a client's whole catalogue, deliberately ignoring the range
 * selector. A "1M+ club" is a lifetime record: a video does not leave it
 * because it aged past thirty days. Wiring the boards to the range filter is
 * what made them look broken, since the default 30 day window held none of
 * Caleb's six million-view videos, the newest of which is from October 2025.
 *
 * The range still means something here, so each tier also reports how many of
 * its members landed inside the selected window. That is momentum rather than
 * a filter.
 *
 * Kept separate from the screen because it is pure and worth a check: this is
 * exactly the sort of wiring that silently regresses.
 */

export interface ViewTier {
  /** Highest viewed first, capped for display. */
  posts: ClientPost[];
  /** Everything at or above the threshold, however long the board shows. */
  total: number;
  /** How many of those were published inside the selected range. */
  addedInRange: number;
}

/**
 * Narrows posts to one platform and rescopes each post's numbers to it, so a
 * cross-posted video is ranked on the views it earned on that platform alone.
 */
export function scopeToPlatform(posts: ClientPost[], tab: string): ClientPost[] {
  if (tab === "all") return posts;
  return posts
    .filter((p) => p.platforms.includes(tab as Platform))
    .map((p) => ({
      ...p,
      byPlatform: p.byPlatform.filter((b) => b.platform === tab),
      views: p.byPlatform.find((b) => b.platform === tab)?.views ?? 0,
      platforms: [tab as Platform],
    }));
}

/**
 * One tier of the board.
 *
 * `lifetime` is every post, already platform-scoped and never date-filtered.
 * `cutoff` is the start of the selected range as a timestamp, or 0 for all
 * time, and only affects the momentum count.
 */
export function buildTier(
  lifetime: ClientPost[],
  min: number,
  max: number | null,
  cutoff: number,
  limit = 10,
): ViewTier {
  const inTier = lifetime.filter((p) => p.views >= min && (max === null || p.views < max));
  return {
    posts: [...inTier].sort((a, b) => b.views - a.views).slice(0, limit),
    total: inTier.length,
    addedInRange: inTier.filter((p) => new Date(p.publishedAt).getTime() >= cutoff).length,
  };
}

export const TIER_BOUNDS = [
  { key: "1m", min: 1_000_000, max: null as number | null },
  { key: "100k", min: 100_000, max: 1_000_000 as number | null },
  { key: "10k", min: 10_000, max: 100_000 as number | null },
] as const;
