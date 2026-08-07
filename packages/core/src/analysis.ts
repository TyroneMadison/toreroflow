/**
 * The video scoring rubric, as code.
 *
 * Three dials (Hook, Retention, Payoff) come back from the model. The peak
 * score does not: it is arithmetic, so it lives here rather than in a prompt,
 * where a model that likes the video could quietly round it up. The weighting
 * and the cap are the two numbers in the rubric that must never drift, so both
 * are pinned in analysis.check.ts.
 *
 * Source: docs/research-private/format-finder/scoring-rubric.md, sections 1-4.
 */

export type ScoreDial = "hook" | "retention" | "payoff" | "peak";

export interface ScoreBand {
  /** Lowest score in the band, inclusive. */
  min: number;
  /** Highest score in the band, inclusive. */
  max: number;
  /** The word the UI puts under the number. */
  label: string;
}

/**
 * The three gauges share one ladder (rubric sections 1, 2 and 3, which use the
 * same four cut points for every dial).
 */
const DIAL_BANDS: readonly ScoreBand[] = [
  { min: 0, max: 39, label: "Failing" },
  { min: 40, max: 59, label: "Average" },
  { min: 60, max: 79, label: "Good" },
  { min: 80, max: 100, label: "Excellent" },
];

/**
 * Peak has its own, longer ladder (rubric section 4, "Calibration").
 *
 * The bands are deliberately unkind in the middle: a decent-effort upload lands
 * at "Average" in the thirties and forties, and "Exceptional" is meant to go
 * unused most days. The encouragement belongs in the action plan, not here.
 */
const PEAK_BANDS: readonly ScoreBand[] = [
  { min: 0, max: 20, label: "Broken" },
  { min: 21, max: 34, label: "Weak" },
  { min: 35, max: 50, label: "Average" },
  { min: 51, max: 59, label: "Above average" },
  { min: 60, max: 75, label: "Good" },
  { min: 76, max: 84, label: "Very good" },
  { min: 85, max: 100, label: "Exceptional" },
];

export const SCORE_BANDS: Record<ScoreDial, readonly ScoreBand[]> = {
  hook: DIAL_BANDS,
  retention: DIAL_BANDS,
  payoff: DIAL_BANDS,
  peak: PEAK_BANDS,
};

/** Model output is not trusted to be a number in range. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** The word for a score. Defaults to the peak ladder, which is the headline number. */
export function bandFor(score: number, dial: ScoreDial = "peak"): string {
  const s = clampScore(score);
  const bands = SCORE_BANDS[dial] ?? PEAK_BANDS;
  const hit = bands.find((b) => s >= b.min && s <= b.max) ?? bands[bands.length - 1];
  return hit.label;
}

/**
 * Peak = 0.40 Hook + 0.35 Retention + 0.25 Payoff, rounded, then capped.
 *
 * Hook carries the most weight because distribution is decided in the first
 * seconds, and the cap is the harder half of that rule: if the hook is below 40
 * nobody stops for the video, so however good the middle and the ending are the
 * peak cannot pass 55. Written as whole numbers over 100 rather than 0.4 and
 * friends so integer inputs give an exact half at the rounding boundary instead
 * of a floating point near-miss.
 */
export function peakScore(hook: number, retention: number, payoff: number): number {
  const h = clampScore(hook);
  const weighted = Math.round((40 * h + 35 * clampScore(retention) + 25 * clampScore(payoff)) / 100);
  return h < 40 ? Math.min(weighted, 55) : weighted;
}

export type MomentKind = "strong" | "risk";

const STRONG_WORDS = new Set(["strong", "strength", "good", "win", "positive", "keep"]);

/**
 * Normalise whatever the model called a moment into the two the strip draws.
 *
 * Anything that is not clearly marked a strength becomes a risk. A red pill
 * invites the creator to open it and read the detail; a white one does not, so
 * an unreadable label is safer red than white.
 */
export function momentKind(raw: unknown): MomentKind {
  return typeof raw === "string" && STRONG_WORDS.has(raw.trim().toLowerCase()) ? "strong" : "risk";
}

/* ---- the stored result shape, shared by the worker that writes it and the API that serves it ---- */

export interface AnalysisMoment {
  /** Seconds into the video, to one decimal (the rubric asks for word-level precision). */
  at: number;
  kind: MomentKind;
  label: string;
  detail: string;
}

export interface AnalysisStep {
  title: string;
  why: string;
  fix: string;
}

export interface AnalysisSpinOff {
  idea: string;
  hook: string;
}

export interface AnalysisTranscriptLine {
  start: number;
  end: number;
  text: string;
}

export interface AnalysisResult {
  scores: { hook: number; retention: number; payoff: number; peak: number };
  category: string;
  overview: string;
  viewerValue: string;
  whatWorked: string[];
  /** Two to five, hook moment first (rubric section 5). */
  moments: AnalysisMoment[];
  /** Exactly four, ordered by expected impact (rubric section 6). */
  actionPlan: AnalysisStep[];
  spinOffs: AnalysisSpinOff[];
  transcript: AnalysisTranscriptLine[];
}
