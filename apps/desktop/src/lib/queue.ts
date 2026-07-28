import type { PostTargetInfo } from "./api";

/**
 * The rows the queue card shows, in the order it shows them.
 *
 * Failed posts are included and sorted first. A scheduled video's card
 * leaves the upload list, so a failure listed nowhere would be a problem
 * the operator cannot see or clear. Posted work is finished and belongs to
 * Analytics, so it stays out.
 */
export function queueRows(posts: PostTargetInfo[], max = 6): PostTargetInfo[] {
  const rank = (p: PostTargetInfo): number => (p.status === "failed" ? 0 : 1);
  return posts
    .filter(
      (p) => p.status === "scheduled" || p.status === "publishing" || p.status === "failed",
    )
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "");
    })
    .slice(0, max);
}
