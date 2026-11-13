/**
 * Clip scores. Pure, so the worker, the API and the checks agree on one rule.
 *
 * raw    = hook + flow + value + trend (each 0-10, so 0-40)
 * prompt = round(0.8 * raw + 0.2 * relevance * 4) when the job had a prompt
 * rank   = by raw, ties by hook then flow
 * shown  = round(99 - 40 * (rank - 1) / max(1, N - 1))
 *
 * ponytail: shown is a rank curve, not a grade. The top clip of any job reads
 * 99 and the bottom 59, which is the point: it sorts a job, it does not
 * compare two jobs.
 */

export interface SubScores {
  hook: number;
  flow: number;
  value: number;
  trend: number;
  relevance?: number | null;
}

const clamp10 = (n: number) => Math.max(0, Math.min(10, Math.round(Number.isFinite(n) ? n : 0)));

/** Phase 9: per-client rubric weights (average 1), see tuneJudge. */
export type ScoreWeights = { hook: number; flow: number; value: number; trend: number };

export function rawScore(s: SubScores, hasPrompt = false, w?: ScoreWeights | null): number {
  const base = w
    ? Math.round(w.hook * clamp10(s.hook) + w.flow * clamp10(s.flow) + w.value * clamp10(s.value) + w.trend * clamp10(s.trend))
    : clamp10(s.hook) + clamp10(s.flow) + clamp10(s.value) + clamp10(s.trend);
  if (!hasPrompt || s.relevance == null) return base;
  return Math.round(0.8 * base + 0.2 * clamp10(s.relevance) * 4);
}

export function shownScore(rank: number, n: number): number {
  return Math.round(99 - (40 * (rank - 1)) / Math.max(1, n - 1));
}

export interface Ranked<T> {
  item: T;
  raw: number;
  rank: number;
  score: number;
}

/** Stable: equal raw, hook and flow keep their input order. */
export function rankClips<T extends SubScores>(items: T[], hasPrompt = false, w?: ScoreWeights | null): Ranked<T>[] {
  const withRaw = items.map((item, i) => ({ item, raw: rawScore(item, hasPrompt, w), i }));
  withRaw.sort(
    (a, b) =>
      b.raw - a.raw ||
      clamp10(b.item.hook) - clamp10(a.item.hook) ||
      clamp10(b.item.flow) - clamp10(a.item.flow) ||
      a.i - b.i,
  );
  const n = withRaw.length;
  return withRaw.map((r, k) => ({ item: r.item, raw: r.raw, rank: k + 1, score: shownScore(k + 1, n) }));
}

export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
