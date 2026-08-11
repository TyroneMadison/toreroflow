import { reportsMetric } from "@toreroflow/core";

interface WatchPost {
  platforms: readonly string[];
  views: number;
  avgWatchSec: number | null;
  totalWatchSec: number | null;
}

/**
 * Hours watched across a set of posts, or null when nothing measured it.
 *
 * The previous version multiplied views by an average and, for any post
 * reporting no watch time, substituted the account-wide average. TikTok and
 * YouTube report none, so their views inherited an Instagram figure and the
 * KPI counted hours nobody ever measured.
 *
 * Now: the measured total where the platform reports one, the post's own
 * average times its views where it reports that instead, and nothing at all
 * otherwise. This makes the number smaller. The old one was wrong.
 */
export function watchHours(posts: readonly WatchPost[]): number | null {
  let seconds = 0;
  let measured = false;
  for (const p of posts) {
    if (reportsMetric("totalWatch", p.platforms) && p.totalWatchSec != null && p.totalWatchSec > 0) {
      seconds += p.totalWatchSec;
      measured = true;
      continue;
    }
    if (reportsMetric("avgWatch", p.platforms) && p.avgWatchSec != null && p.avgWatchSec > 0) {
      seconds += p.views * p.avgWatchSec;
      measured = true;
    }
  }
  return measured ? seconds / 3600 : null;
}
