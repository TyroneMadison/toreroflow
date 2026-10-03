/**
 * What a client has had from the agency since they joined.
 *
 * Two different kinds of number, kept apart on purpose. Follower change is
 * the whole account, including anything the client posted themselves, so it
 * is context and never credited to the work. Views are counted only on posts
 * the app itself published, from the platform's own count, so that figure is
 * the work and nothing else.
 */

export interface FollowerPoint {
  capturedAt: Date | string;
  followers: number | null;
}

export interface FollowerChange {
  start: number;
  startOn: string;
  now: number;
  nowOn: string;
  change: number;
  /** Null when the start was zero, where a percentage means nothing. */
  pct: number | null;
}

const day = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/**
 * Earliest and latest follower counts from the join day on.
 *
 * Null until two different days exist, because one day is a baseline, not a
 * change. Zero counts are skipped: no client account has zero followers, and
 * a provider that sends zero for "unknown" would otherwise read as a launch
 * from nothing.
 */
export function followerChange(points: FollowerPoint[], joinedAt: Date | string): FollowerChange | null {
  const from = day(joinedAt);
  const usable = points
    .filter((p): p is FollowerPoint & { followers: number } => p.followers != null && p.followers > 0)
    .filter((p) => day(p.capturedAt) >= from)
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last || day(first.capturedAt) === day(last.capturedAt)) return null;
  const change = last.followers - first.followers;
  return {
    start: first.followers,
    startOn: day(first.capturedAt),
    now: last.followers,
    nowOn: day(last.capturedAt),
    change,
    pct: first.followers > 0 ? Math.round((change / first.followers) * 1000) / 10 : null,
  };
}

export interface PublishedPost {
  platform: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  /** The platform's latest count; null when it has not reported this post yet. */
  views: number | null;
}

export interface ViewTotals {
  /** Views across every post that reported. */
  total: number;
  /** Posts with a view count, out of `posts`. */
  reporting: number;
  posts: number;
  byPlatform: Record<string, { posts: number; reporting: number; views: number }>;
  best: PublishedPost | null;
}

/**
 * Views on the app's own posts.
 *
 * A post that has not reported is counted in `posts` but not in `reporting`,
 * so the screen can say how much of the work the total covers instead of
 * passing off a partial sum as the whole.
 */
export function viewTotals(posts: PublishedPost[]): ViewTotals {
  const byPlatform: ViewTotals["byPlatform"] = {};
  let total = 0;
  let reporting = 0;
  let best: PublishedPost | null = null;
  for (const p of posts) {
    const row = (byPlatform[p.platform] ??= { posts: 0, reporting: 0, views: 0 });
    row.posts += 1;
    if (p.views == null) continue;
    row.reporting += 1;
    row.views += p.views;
    reporting += 1;
    total += p.views;
    if (!best || p.views > (best.views ?? 0)) best = p;
  }
  return { total, reporting, posts: posts.length, byPlatform, best };
}
