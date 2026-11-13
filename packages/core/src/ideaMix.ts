import { ideaSimilarity } from "./ideaDedup";

/**
 * Keeps a generated batch varied and learns, quietly, what a brand saves.
 * Used by Super generate (all creators, or one creator from its Generate button).
 */

/* ---- distinctiveness ---- */

/** Character trigrams of the normalised text, for catching reworded repeats. */
function trigrams(text: string): Set<string> {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a), tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Near duplicate: word overlap at or above 0.6, or trigram overlap at or above 0.55. */
export function nearDuplicate(a: string, b: string): boolean {
  return ideaSimilarity(a, b) >= 0.6 || trigramSimilarity(a, b) >= 0.55;
}

/** Most ideas one format, one stage or one hook style may take in a batch. */
export function batchCaps(total: number): { perFormat: number; perStage: number; perHook: number } {
  return {
    perFormat: Math.max(2, Math.ceil(total / 5)),
    perStage: Math.max(2, Math.ceil(total * 0.55)),
    perHook: Math.max(2, Math.ceil(total / 6)),
  };
}

export interface MixIdea {
  text: string;
  label?: string;
  format?: string;
  funnelStage?: string | null;
}

/**
 * Drops near duplicates (inside the batch and against ideas already saved) and
 * anything past the per-format, per-stage and per-hook caps, keeping order.
 */
export function enforceMix<T extends MixIdea>(ideas: T[], total: number, saved: readonly string[] = []): T[] {
  const caps = batchCaps(total);
  const count = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
  const byFormat = new Map<string, number>(), byStage = new Map<string, number>(), byHook = new Map<string, number>();
  const kept: T[] = [];
  for (const i of ideas) {
    if (saved.some((s) => nearDuplicate(i.text, s))) continue;
    if (kept.some((k) => nearDuplicate(i.text, k.text))) continue;
    const f = (i.format ?? "").toLowerCase(), s = (i.funnelStage ?? "") as string, h = (i.label ?? "").toLowerCase().trim();
    if (f && count(byFormat, f) >= caps.perFormat) continue;
    if (s && count(byStage, s) >= caps.perStage) continue;
    if (h && count(byHook, h) >= caps.perHook) continue;
    if (f) byFormat.set(f, count(byFormat, f) + 1);
    if (s) byStage.set(s, count(byStage, s) + 1);
    if (h) byHook.set(h, count(byHook, h) + 1);
    kept.push(i);
  }
  return kept;
}

/* ---- learning loop ---- */

export interface FeedbackEvent {
  format: string | null;
  funnelStage: string | null;
  hookStyle: string | null;
  creator: string | null;
  saved: boolean;
}

/** Below this many events a value says nothing yet. */
export const PREF_MIN_SAMPLES = 5;
/** Prior strength: a value is pulled toward the brand's overall save rate as if it had this many events. */
export const PREF_PRIOR = 4;

export interface PrefWeight { key: string; value: string; n: number; rate: number; weight: number }

/**
 * Smoothed save rate per format, stage, hook style and creator, as a weight
 * around 1 (above 1 means saved more than this brand's average), clamped to
 * 0.75..1.35 so it nudges and never takes over.
 */
export function preferenceProfile(events: readonly FeedbackEvent[]): PrefWeight[] {
  if (!events.length) return [];
  const base = events.filter((e) => e.saved).length / events.length;
  if (base === 0) return [];
  const out: PrefWeight[] = [];
  for (const key of ["format", "funnelStage", "hookStyle", "creator"] as const) {
    const m = new Map<string, { n: number; s: number }>();
    for (const e of events) {
      const v = (e[key] ?? "").trim();
      if (!v) continue;
      const c = m.get(v) ?? { n: 0, s: 0 };
      c.n += 1;
      if (e.saved) c.s += 1;
      m.set(v, c);
    }
    for (const [value, c] of m) {
      if (c.n < PREF_MIN_SAMPLES) continue;
      const rate = (c.s + PREF_PRIOR * base) / (c.n + PREF_PRIOR);
      const weight = Math.min(1.35, Math.max(0.75, rate / base));
      out.push({ key, value, n: c.n, rate, weight: Math.round(weight * 100) / 100 });
    }
  }
  return out;
}

/** Soft prompt lines from the profile, or empty when there is nothing to say. */
export function preferencePrompt(profile: readonly PrefWeight[]): string {
  const up = profile.filter((p) => p.weight >= 1.1).map((p) => `${p.value} (${p.key})`);
  const down = profile.filter((p) => p.weight <= 0.9).map((p) => `${p.value} (${p.key})`);
  if (!up.length && !down.length) return "";
  return (
    "Soft preference from what this brand saved before (a nudge only; still keep every batch varied " +
    "and respect the format and stage caps). " +
    (up.length ? `Lean a little more toward: ${up.join(", ")}. ` : "") +
    (down.length ? `Use a little less: ${down.join(", ")}.` : "")
  ).trim();
}

/** A few topic words for the feedback table. */
export function topicKeywords(text: string): string[] {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "you", "your", "is", "it", "this", "that", "with", "how", "what", "why", "my", "we", "our", "i"]);
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)))].slice(0, 8);
}
