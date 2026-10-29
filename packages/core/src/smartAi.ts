/**
 * Phase 9 (Smarter AI), the free half: language fallback, a visual score from
 * scene cuts and sampled face frames, per-client trend terms, and a judge
 * tuned by likes, dislikes and real post performance. Pure, so the worker,
 * the API and the checks agree.
 *
 * ponytail: every model or web call the spec names (multimodal frames to a
 * vision model, daily web_search trends) is replaced here by a heuristic over
 * data already on the box. The AI judge only gets the tuned examples when a
 * key already exists; nothing here spends.
 */
import { terms } from "./clipCurate";
import type { SubScores } from "./clipScore";
import type { FaceTrack } from "./reframe";

type Range = [number, number];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

// ---------------------------------------------------------------- language

/** Below this whisper's own detection probability, the guess is not trusted. */
export const LANG_MIN_PROB = 0.6;

export type LanguageSource = "set" | "detected" | "fallback";

/**
 * The language to keep. A language set up front always wins; a confident
 * detection is kept; a weak one falls back to the hint (the client's usual
 * language), else English.
 */
export function pickLanguage(o: { forced?: string | null; detected?: string | null; prob?: number | null; hint?: string | null }): {
  language: string;
  source: LanguageSource;
} {
  if (o.forced) return { language: o.forced, source: "set" };
  const fallback = o.hint || "en";
  if (!o.detected) return { language: fallback, source: "fallback" };
  // ponytail: no probability (an older captions service) means trust it only
  // when it agrees with the hint.
  if (o.prob == null) return o.detected === fallback ? { language: o.detected, source: "detected" } : { language: fallback, source: "fallback" };
  return o.prob >= LANG_MIN_PROB ? { language: o.detected, source: "detected" } : { language: fallback, source: "fallback" };
}

/**
 * A transcript a retry must not reuse: detected (not set) and either weak or,
 * with no recorded probability, in a language other than the hint.
 */
export function transcriptSuspect(
  a: { language?: string | null; languageProb?: number | null; languageSource?: string | null },
  hint?: string | null,
): boolean {
  if (a.languageSource === "set" || a.languageSource === "fallback") return false;
  if (!a.language) return false;
  if (a.languageProb != null) return a.languageProb < LANG_MIN_PROB;
  return a.language !== (hint || "en");
}

/** The client's usual language: the most common across its trusted sources. */
export function languageHint(langs: (string | null | undefined)[]): string {
  const n = new Map<string, number>();
  for (const l of langs) if (l) n.set(l, (n.get(l) ?? 0) + 1);
  let best = "en";
  let top = 0;
  for (const [l, c] of n) if (c > top) [best, top] = [l, c];
  return best;
}

// ------------------------------------------------------------------ visual

export interface VisualFeatures {
  /** 0-10. */
  visual: number;
  facePct: number;
  cutsPerMin: number;
  talking: number;
  note: string;
}

/**
 * What the frames say about a clip: a face on screen, the speaker's mouth
 * moving, and a cut rhythm that is neither a static slide nor strobing.
 */
export function visualFeatures(ranges: Range[], cuts: number[], track: FaceTrack | null): VisualFeatures {
  const inside = (t: number) => ranges.some(([a, b]) => t >= a && t < b);
  const dur = ranges.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
  const frames = track ? track.frames.filter((f) => inside(f.t)) : [];
  const withFace = frames.filter((f) => f.faces.length > 0);
  const facePct = frames.length ? withFace.length / frames.length : 0;
  const talking = withFace.length ? withFace.reduce((s, f) => s + Math.max(...f.faces.map((x) => x.mouth ?? 0)), 0) / withFace.length : 0;
  const cutsIn = cuts.filter((t) => ranges.some(([a, b]) => t > a + 0.2 && t < b - 0.2)).length;
  const cutsPerMin = dur > 0 ? (cutsIn * 60) / dur : 0;
  // Cut rhythm: 2-12 a minute reads as edited; none is a static frame; more
  // than 30 is strobing.
  const rhythm = cutsPerMin === 0 ? 0.4 : cutsPerMin <= 12 ? (cutsPerMin >= 2 ? 1 : 0.7) : cutsPerMin <= 30 ? 0.7 : 0.3;
  const hasTrack = !!track && frames.length > 0;
  const visual = Math.round(
    hasTrack ? 10 * (0.45 * facePct + 0.25 * clamp(talking * 4, 0, 1) + 0.3 * rhythm) : 10 * (0.5 + 0.5 * rhythm) * 0.7,
  );
  const note = !hasTrack
    ? cutsIn
      ? `${cutsIn} cut${cutsIn > 1 ? "s" : ""}, no face samples.`
      : "No frame samples."
    : facePct >= 0.7
      ? `Face on screen ${Math.round(facePct * 100)}% of the time${cutsIn ? `, ${cutsIn} cut${cutsIn > 1 ? "s" : ""}` : ""}.`
      : facePct > 0
        ? `Face on screen only ${Math.round(facePct * 100)}% of the time.`
        : "No face on screen.";
  return { visual: clamp(visual, 0, 10), facePct, cutsPerMin, talking, note };
}

/** The visual score nudges hook (first look) and value; at most +-2. */
export function applyVisual<T extends SubScores & { comments?: Record<string, string> }>(j: T, v: VisualFeatures): T {
  const d = Math.round((v.visual - 5) / 2.5);
  return {
    ...j,
    hook: clamp(Math.round(j.hook + d), 0, 10),
    value: clamp(Math.round(j.value + Math.sign(d)), 0, 10),
    comments: { ...(j.comments ?? {}), visual: v.note },
  };
}

// ------------------------------------------------------------------- trend

export interface TrendTerm {
  term: string;
  weight: number;
  source: "niche" | "keyword" | "top-post" | "liked";
}

/**
 * The client's trend terms for the day: the niche and its keywords, plus the
 * words that keep showing up in its best-performing posts and liked clips.
 */
export function trendTermsFrom(o: {
  niche?: string | null;
  keywords?: string[];
  topPosts?: { text: string; views: number }[];
  liked?: string[];
  max?: number;
}): TrendTerm[] {
  const out = new Map<string, TrendTerm>();
  const add = (term: string, weight: number, source: TrendTerm["source"]) => {
    const prev = out.get(term);
    if (!prev || prev.weight < weight) out.set(term, { term, weight: Math.round(weight * 100) / 100, source });
    else prev.weight = Math.round(Math.min(1, prev.weight + weight / 4) * 100) / 100;
  };
  for (const t of terms(o.niche ?? "")) add(t, 1, "niche");
  for (const k of o.keywords ?? []) for (const t of terms(k)) add(t, 0.9, "keyword");
  const posts = [...(o.topPosts ?? [])].sort((a, b) => b.views - a.views);
  const top = posts[0]?.views || 1;
  const counts = new Map<string, number>();
  posts.forEach((p) => {
    for (const t of terms(p.text)) if (t.length >= 4 && !t.startsWith("http")) counts.set(t, (counts.get(t) ?? 0) + p.views / top);
  });
  for (const [t, c] of counts) if (c >= 0.5) add(t, Math.min(0.8, 0.3 + c / 4), "top-post");
  const liked = new Map<string, number>();
  for (const text of o.liked ?? []) for (const t of terms(text)) if (t.length >= 5) liked.set(t, (liked.get(t) ?? 0) + 1);
  for (const [t, c] of liked) if (c >= 2) add(t, Math.min(0.7, 0.3 + c / 10), "liked");
  return [...out.values()].sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)).slice(0, o.max ?? 40);
}

/** 0-10 for how much of the clip rides the client's trend terms. */
export function trendScore(text: string, tt: TrendTerm[]): { score: number; hits: string[] } {
  if (!tt.length) return { score: 0, hits: [] };
  const have = terms(text);
  const hits = tt.filter((t) => have.has(t.term));
  const mass = hits.reduce((s, t) => s + t.weight, 0);
  // Three strong hits is a full trend score.
  return { score: clamp(Math.round((10 * mass) / 3), 0, 10), hits: hits.slice(0, 5).map((h) => h.term) };
}

/** Blend the judge's own trend with the client terms (the terms weigh 60%). */
export function blendTrend(judged: number, fromTerms: { score: number; hits: string[] }, haveTerms: boolean): number {
  if (!haveTerms) return judged;
  return clamp(Math.round(0.4 * judged + 0.6 * fromTerms.score), 0, 10);
}

// ------------------------------------------------------------ judge tuning

export type Dim = "hook" | "flow" | "value" | "trend";
export const DIMS: Dim[] = ["hook", "flow", "value", "trend"];
export type Weights = Record<Dim, number>;
export const EVEN: Weights = { hook: 1, flow: 1, value: 1, trend: 1 };

/** The dislike chips and the dimension each one blames. */
export const REASON_DIM: Record<string, Dim> = {
  "Starts mid-thought": "hook",
  "Ends too early": "flow",
  Boring: "value",
  "Off-topic": "trend",
  "Too long": "flow",
  "Bad framing": "hook",
};

export interface TuneSample {
  sub: SubScores;
  /** "up" | "down" | "down:<reason>" | null */
  feedback?: string | null;
  /** Views over the client's median views for posted clips (1 = typical). */
  perf?: number | null;
  title?: string;
  text?: string;
}

export interface JudgeTuning {
  weights: Weights;
  n: number;
  reasons: Record<string, number>;
  examples: { good: string[]; bad: { title: string; reason?: string }[] };
  at?: string;
}

/**
 * Rubric weights from what the client keeps and posts. A dimension the liked
 * (or over-performing) clips score high on and the disliked ones low gains
 * weight; each dislike reason blames one dimension. Weights stay 0.5-1.6 and
 * average 1, so raw keeps its 0-40 range. Under 3 samples: even weights.
 */
export function tuneJudge(samples: TuneSample[]): JudgeTuning {
  const good: TuneSample[] = [];
  const bad: TuneSample[] = [];
  const reasons: Record<string, number> = {};
  for (const s of samples) {
    const up = s.feedback?.startsWith("up") || (s.perf != null && s.perf >= 1.5);
    const down = s.feedback?.startsWith("down") || (s.perf != null && s.perf <= 0.5);
    if (up && !s.feedback?.startsWith("down")) good.push(s);
    else if (down) bad.push(s);
    const r = s.feedback?.startsWith("down:") ? s.feedback.slice(5) : null;
    if (r) reasons[r] = (reasons[r] ?? 0) + 1;
  }
  const n = good.length + bad.length;
  const examples = {
    good: good.slice(0, 3).map((g) => g.title ?? "").filter(Boolean),
    bad: bad.slice(0, 3).map((b) => ({ title: b.title ?? "", reason: b.feedback?.startsWith("down:") ? b.feedback.slice(5) : undefined })),
  };
  if (n < 3) return { weights: { ...EVEN }, n, reasons, examples };
  const mean = (xs: TuneSample[], d: Dim) => (xs.length ? xs.reduce((s, x) => s + clamp(x.sub[d], 0, 10), 0) / xs.length : 5);
  const raw: Weights = { ...EVEN };
  for (const d of DIMS) raw[d] = 1 + clamp((mean(good, d) - mean(bad, d)) / 10, -0.5, 0.5);
  const blamed = Object.entries(reasons).reduce((s, [, c]) => s + c, 0);
  for (const [r, c] of Object.entries(reasons)) {
    const d = REASON_DIM[r];
    if (d && blamed) raw[d] += (0.4 * c) / blamed;
  }
  const avg = DIMS.reduce((s, d) => s + raw[d], 0) / 4;
  const weights = { ...EVEN };
  for (const d of DIMS) weights[d] = Math.round(clamp(raw[d] / avg, 0.5, 1.6) * 100) / 100;
  return { weights, n, reasons, examples };
}

/** One rubric line for an AI judge prompt (only built when a key exists). */
export function tuningPrompt(t: JudgeTuning | null | undefined): string {
  if (!t || t.n < 3) return "";
  const w = DIMS.map((d) => `${d} x${t.weights[d]}`).join(", ");
  const good = t.examples.good.map((g) => `"${g}"`).join("; ");
  const bad = t.examples.bad.map((b) => `"${b.title}"${b.reason ? ` (${b.reason})` : ""}`).join("; ");
  return `This client's taste (from ${t.n} rated or posted clips): weigh ${w}.${good ? ` Kept: ${good}.` : ""}${bad ? ` Rejected: ${bad}.` : ""}`;
}
