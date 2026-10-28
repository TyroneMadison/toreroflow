import type { Rollup, WorkflowPlatform } from "@toreroflow/contracts";

/**
 * W4 rollup: one source video's numbers across YouTube, Instagram and TikTok,
 * with totals. Pure: the route hands in one entry per published target.
 *
 * Counts add up (two Instagram targets of one video add together). Average
 * watch time cannot be added, so it is weighted by views, per platform and in
 * the total. A cell is null when that platform has no post or no number,
 * never 0 as a stand-in.
 */
export interface RollupSource {
  platform: WorkflowPlatform;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  avgWatchSec: number | null;
}

const COUNTS = ["views", "likes", "comments", "shares"] as const;
const PLATFORMS: WorkflowPlatform[] = ["youtube", "instagram", "tiktok"];

const sum = (xs: (number | null)[]) => {
  const known = xs.filter((x): x is number => x != null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/** Views-weighted average watch time; a source without views counts once. */
const avgWatch = (sources: RollupSource[]) => {
  const known = sources.filter((s) => s.avgWatchSec != null);
  if (!known.length) return null;
  const weight = (s: RollupSource) => (s.views && s.views > 0 ? s.views : 1);
  const w = known.reduce((a, s) => a + weight(s), 0);
  return Math.round((known.reduce((a, s) => a + s.avgWatchSec! * weight(s), 0) / w) * 10) / 10;
};

export function buildRollup(videoId: string, sources: RollupSource[]): Rollup {
  const by = (p: WorkflowPlatform) => sources.filter((s) => s.platform === p);
  const row = (metric: Rollup["rows"][number]["metric"], of: (ss: RollupSource[]) => number | null) => {
    const [youtube, instagram, tiktok] = PLATFORMS.map((p) => of(by(p)));
    return { metric, youtube: youtube!, instagram: instagram!, tiktok: tiktok!, total: of(sources) };
  };
  return {
    videoId,
    rows: [...COUNTS.map((m) => row(m, (ss) => sum(ss.map((s) => s[m])))), row("avgWatchSeconds", avgWatch)],
  };
}
