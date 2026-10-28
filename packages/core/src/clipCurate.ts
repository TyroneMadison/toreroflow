/**
 * Clip curation helpers and the free local curator.
 *
 * Everything here is pure: sentences from words, the numbered transcript an
 * LLM curator reads, snapping and merging ranges, de-duplication, and a
 * heuristic curator + judge that needs no key and costs nothing. The worker
 * picks a provider (Anthropic when a key is configured, this otherwise) and
 * runs the same snap/dedupe/score rules on whatever comes back.
 *
 * ponytail: the heuristic is a ranking of transcript features (questions,
 * claims, numbers, dangling openers, filler). It does not watch the video;
 * that is what the judge model is for when one is configured.
 */
import type { Word } from "./autoCut";
import { emptyDoc, type EditDoc, type Shot } from "./editDoc";

export type Range = [number, number];

export interface ClipSentence {
  i: number;
  start: number;
  end: number;
  text: string;
  /** Index into the spoken-word list of the first and last word. */
  w0: number;
  w1: number;
  fillers: number;
}

export interface LengthTarget {
  key: string;
  min: number;
  max: number;
}

export const LENGTH_TARGETS: Record<string, LengthTarget> = {
  "<30": { key: "<30", min: 12, max: 30 },
  "15-60": { key: "15-60", min: 15, max: 60 },
  "30-60": { key: "30-60", min: 30, max: 60 },
  "60-90": { key: "60-90", min: 60, max: 90 },
  "60-180": { key: "60-180", min: 60, max: 180 },
  "90-180": { key: "90-180", min: 90, max: 180 },
};

/** "auto" runs two targets in one job: short and long. */
export function lengthTargets(choice: string | undefined): LengthTarget[] {
  if (!choice || choice === "auto") return [LENGTH_TARGETS["15-60"], LENGTH_TARGETS["60-180"]];
  const t = LENGTH_TARGETS[choice];
  return t ? [t] : [LENGTH_TARGETS["15-60"], LENGTH_TARGETS["60-180"]];
}

/** About one clip per 45 s of source, at least five. */
export function targetClipCount(durationSec: number): number {
  return Math.max(5, Math.round(durationSec / 45));
}

const spoken = (words: Word[]) => words.filter((w) => w.kind !== "silence" && w.word.trim());

/** ClipSentence ends at terminal punctuation or a pause over gapSec. */
export function sentences(words: Word[], gapSec = 0.8): ClipSentence[] {
  const ws = spoken(words);
  const out: ClipSentence[] = [];
  let s0 = 0;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    const next = ws[k + 1];
    const terminal = /[.?!]["')\]]*$/.test(w.word.trim());
    const gap = next ? next.start - w.end : Infinity;
    const long = w.end - ws[s0].start > 20 && /[,;:]$/.test(w.word.trim());
    if (terminal || gap > gapSec || !next || long) {
      const part = ws.slice(s0, k + 1);
      out.push({
        i: out.length,
        start: part[0].start,
        end: part[part.length - 1].end,
        text: part.map((p) => p.word.trim()).join(" ").replace(/\s+/g, " "),
        w0: s0,
        w1: k,
        fillers: part.filter((p) => p.kind === "filler").length,
      });
      s0 = k + 1;
    }
  }
  return out;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** "[i] (m:ss–m:ss) text" lines, what an LLM curator reads. */
export function numberedLines(ss: ClipSentence[]): string {
  return ss.map((s) => `[${s.i}] (${mmss(s.start)}–${mmss(s.end)}) ${s.text}`).join("\n");
}

/** ~12 min windows with 1 min overlap, as sentence index spans. */
export function curateWindows(ss: ClipSentence[], windowSec = 720, overlapSec = 60): { from: number; to: number }[] {
  if (!ss.length) return [];
  const out: { from: number; to: number }[] = [];
  let t = ss[0].start;
  const end = ss[ss.length - 1].end;
  for (;;) {
    const from = ss.findIndex((s) => s.end > t);
    let to = from;
    while (to + 1 < ss.length && ss[to + 1].start < t + windowSec) to++;
    out.push({ from, to });
    if (ss[to].end >= end - 1e-6 || to === ss.length - 1) break;
    t += windowSec - overlapSec;
  }
  return out;
}

/** Line-index ranges (inclusive) to seconds, in play order. */
export function linesToRanges(ss: ClipSentence[], lines: [number, number][]): Range[] {
  const out: Range[] = [];
  for (const [a0, b0] of lines) {
    const a = Math.max(0, Math.min(a0, b0));
    const b = Math.min(ss.length - 1, Math.max(a0, b0));
    if (!ss[a] || !ss[b]) continue;
    out.push([ss[a].start, ss[b].end]);
  }
  return out;
}

/**
 * Start each range at its first word minus 0.15 s and end at its last word
 * plus 0.25 s, then merge consecutive ranges under 0.3 s apart (in play
 * order, only when the second continues the first in source time).
 */
export function snapRanges(ranges: Range[], words: Word[], duration?: number): Range[] {
  const ws = spoken(words);
  const snapped: Range[] = [];
  for (const [s, e] of ranges) {
    const inside = ws.filter((w) => w.end > s + 0.02 && w.start < e - 0.02);
    if (!inside.length) continue;
    const a = Math.max(0, inside[0].start - 0.15);
    let b = inside[inside.length - 1].end + 0.25;
    if (duration !== undefined) b = Math.min(duration, b);
    if (b > a) snapped.push([round3(a), round3(b)]);
  }
  const out: Range[] = [];
  for (const r of snapped) {
    const last = out[out.length - 1];
    if (last && r[0] >= last[0] && r[0] - last[1] < 0.3) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const rangesDuration = (r: Range[]) => r.reduce((a, [s, e]) => a + Math.max(0, e - s), 0);

/** Shared seconds over the shorter clip's length. */
export function overlapRatio(a: Range[], b: Range[]): number {
  let shared = 0;
  for (const [s1, e1] of a) for (const [s2, e2] of b) shared += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  const d = Math.min(rangesDuration(a), rangesDuration(b));
  return d > 0 ? shared / d : 0;
}

/** Keeps the first of any pair over maxOverlap within the same target. */
export function dedupeClips<T extends { ranges: Range[]; lengthTarget: string }>(clips: T[], maxOverlap = 0.8): T[] {
  const kept: T[] = [];
  for (const c of clips) {
    if (kept.some((k) => k.lengthTarget === c.lengthTarget && overlapRatio(k.ranges, c.ranges) > maxOverlap)) continue;
    kept.push(c);
  }
  return kept;
}

/** Words of a clip in play order, the text the judge and search read. */
export function clipText(ranges: Range[], words: Word[]): string {
  const ws = spoken(words);
  return ranges
    .map(([s, e]) => ws.filter((w) => w.start >= s - 0.05 && w.end <= e + 0.05).map((w) => w.word.trim()).join(" "))
    .join(" … ");
}

// ---------------------------------------------------------------------------
// Features

const DANGLING = new Set([
  "and", "but", "so", "because", "which", "that", "it", "it's", "they", "he", "she", "this", "those", "these",
  "also", "or", "then", "like", "um", "uh", "yeah", "right", "okay", "ok", "well", "anyway",
]);
const HOOK_OPENERS = /^(why|how|what|who|when|you|your|never|stop|nobody|most people|the (biggest|real|secret|truth|problem|one)|here's|here is|if you|i (almost|never|quit|lost|made|was)|imagine|let me tell)/i;
const CLAIM = /\b(biggest|mistake|truth|secret|never|always|wrong|worst|best|everyone|nobody|actually|insane|crazy|million|thousand|fail(ed|ure)?|quit|fired|broke|money|free)\b/i;
const VALUE = /\b(\d+|percent|%|\$|step|steps|tip|lesson|learn(ed)?|because|reason|how to|the key|means|works?|result|strategy|system|rule|mistake|data|study|research)\b/i;
const TREND = /\b(ai|money|business|income|side hustle|social media|tiktok|instagram|youtube|health|mindset|startup|career|jobs?|marketing|brand|creator|content|algorithm|science|future|technology|internet|climate|education|learning|productivity)\b/gi;
const FILLER_TEXT = /\b(um+|uh+|you know|i mean|kind of|sort of|like)\b/gi;

export interface SentenceFeatures {
  hook: number;
  claim: number;
  value: number;
  trend: number;
  dangling: boolean;
  complete: boolean;
  filler: number;
  words: number;
}

export function sentenceFeatures(s: ClipSentence): SentenceFeatures {
  const t = s.text.trim();
  const first = t.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
  const words = t.split(/\s+/).filter(Boolean).length;
  const fillerHits = (t.match(FILLER_TEXT) ?? []).length + s.fillers;
  return {
    hook: (/\?\s*$/.test(t) ? 2 : 0) + (HOOK_OPENERS.test(t) ? 2 : 0) + (CLAIM.test(t) ? 1 : 0) + (words >= 5 && words <= 18 ? 1 : 0),
    claim: (t.match(new RegExp(CLAIM.source, "gi")) ?? []).length,
    value: (t.match(new RegExp(VALUE.source, "gi")) ?? []).length,
    trend: (t.match(TREND) ?? []).length,
    dangling: DANGLING.has(first) || /^[a-z]/.test(t) && first.length > 0 && DANGLING.has(first),
    complete: /[.?!]["')\]]*$/.test(t),
    filler: words ? fillerHits / words : 0,
    words,
  };
}

/** A sentence that is mostly filler or a two-word aside: a tangent to skip. */
const isTangent = (f: SentenceFeatures) => f.filler > 0.34 || (f.words <= 3 && f.value === 0 && f.claim === 0);

export interface DraftClip {
  ranges: Range[];
  lengthTarget: string;
  title: string;
  why: string;
  description: string;
  hashtags: string[];
  /** The first range was pulled forward from later in the clip. */
  hookPulled?: boolean;
}

export interface CurateOptions {
  prompt?: string;
  keywords?: string[];
  /** ClipSentence index span to look in (refine). */
  from?: number;
  to?: number;
  count?: number;
}

/**
 * The free curator. For each target length, every non-dangling sentence is a
 * possible start; the span grows sentence by sentence until it fits the
 * target and ends on a complete one. Tangents inside the span are cut out
 * (stitching), and a much stronger short line later in the span becomes the
 * opener (pull-forward). Spans are scored by features, greedily picked
 * without overlap, then snapped by the caller.
 */
export function heuristicCurate(ss: ClipSentence[], durationSec: number, targets: LengthTarget[], opts: CurateOptions = {}): DraftClip[] {
  if (!ss.length) return [];
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(ss.length - 1, opts.to ?? ss.length - 1);
  const feats = ss.map(sentenceFeatures);
  const total = opts.count ?? targetClipCount(durationSec);
  const promptTerms = terms([opts.prompt ?? "", ...(opts.keywords ?? [])].join(" "));
  const out: DraftClip[] = [];

  targets.forEach((target, ti) => {
    // Short targets get the larger share: they are what most jobs post.
    const want = targets.length === 1 ? total : ti === 0 ? Math.ceil(total * 0.6) : Math.max(1, Math.floor(total * 0.4));
    type Span = { a: number; b: number; score: number };
    const spans: Span[] = [];
    for (let a = from; a <= to; a++) {
      const fa = feats[a];
      if (fa.dangling || fa.filler > 0.3) continue;
      let b = a;
      while (b < to && ss[b].end - ss[a].start < target.min) b++;
      if (ss[b].end - ss[a].start < target.min) continue;
      // Prefer ending on a complete sentence inside the max.
      let best = -1;
      for (let k = b; k <= to && ss[k].end - ss[a].start <= target.max; k++) {
        if (feats[k].complete) {
          best = k;
          if (ss[k].end - ss[a].start >= (target.min + target.max) / 2) break;
        }
      }
      if (best < 0) continue;
      const body = feats.slice(a, best + 1);
      const val = body.reduce((x, f) => x + f.value, 0) / body.length;
      const trd = body.reduce((x, f) => x + f.trend, 0);
      const fil = body.reduce((x, f) => x + f.filler, 0) / body.length;
      const rel = promptTerms.size ? overlapTerms(ss.slice(a, best + 1).map((s) => s.text).join(" "), promptTerms) : 0;
      const peakHook = Math.max(...body.map((f) => f.hook));
      // A span whose opener is plain but holds a pullable line scores as if
      // it opened on that line; buildClip makes the same call.
      let opener = fa.hook;
      for (let k = a + 1; k <= best; k++) if (canPull(ss[k], feats[k], fa)) opener = Math.max(opener, feats[k].hook);
      const score = opener * 2 + peakHook * 0.5 + val * 2 + Math.min(3, trd) * 0.6 - fil * 6 + rel * 3;
      spans.push({ a, b: best, score });
    }
    spans.sort((x, y) => y.score - x.score || x.a - y.a);
    const taken: Span[] = [];
    for (const sp of spans) {
      if (taken.length >= want) break;
      const s0 = ss[sp.a].start;
      const e0 = ss[sp.b].end;
      const clash = taken.some((t) => {
        const ov = Math.max(0, Math.min(e0, ss[t.b].end) - Math.max(s0, ss[t.a].start));
        return ov / Math.min(e0 - s0, ss[t.b].end - ss[t.a].start) > 0.35;
      });
      if (!clash) taken.push(sp);
    }
    for (const sp of taken) out.push(buildClip(ss, feats, sp.a, sp.b, target));
  });
  return out;
}

const canPull = (s: ClipSentence, f: SentenceFeatures, first: SentenceFeatures) =>
  s.end - s.start <= 6 && !f.dangling && !isTangent(f) && f.hook >= first.hook + 2 && f.hook >= 3;

function buildClip(ss: ClipSentence[], feats: SentenceFeatures[], a: number, b: number, target: LengthTarget): DraftClip {
  // Stitch: keep sentences in order, skipping tangents (never the first or last).
  const keep: number[] = [];
  for (let k = a; k <= b; k++) if (k === a || k === b || !isTangent(feats[k])) keep.push(k);
  // Pull forward: a short, much stronger line later on opens the clip.
  let hookIdx = -1;
  for (const k of keep.slice(1)) {
    const f = feats[k];
    if (canPull(ss[k], f, feats[a])) {
      if (hookIdx < 0 || f.hook > feats[hookIdx].hook) hookIdx = k;
    }
  }
  const order = hookIdx >= 0 ? [hookIdx, ...keep.filter((k) => k !== hookIdx)] : keep;
  const ranges: Range[] = [];
  let prev = -2;
  for (const k of order) {
    const last = ranges[ranges.length - 1];
    if (last && k === prev + 1) last[1] = ss[k].end;
    else ranges.push([ss[k].start, ss[k].end]);
    prev = k;
  }
  const opener = ss[order[0]].text;
  const all = order.map((k) => ss[k].text).join(" ");
  const why: string[] = [];
  if (hookIdx >= 0) why.push("strong line pulled forward as the hook");
  else if (feats[a].hook >= 3) why.push("opens on a question or claim");
  if (keep.length < b - a + 1) why.push("skips a tangent");
  const v = order.reduce((x, k) => x + feats[k].value, 0);
  if (v >= 3) why.push("concrete specifics");
  if (feats[b].complete) why.push("lands on a complete thought");
  return {
    ranges: ranges.slice(0, 5),
    lengthTarget: target.key,
    title: titleFrom(opener),
    why: why.join(", ") || "self-contained moment",
    description: opener.length > 140 ? `${opener.slice(0, 137)}…` : opener,
    hashtags: hashtagsFrom(all),
    hookPulled: hookIdx >= 0,
  };
}

function titleFrom(text: string): string {
  const w = text.replace(/[^\w\s'$%-]/g, "").split(/\s+/).filter(Boolean).slice(0, 7);
  const t = w.join(" ");
  return t ? t[0].toUpperCase() + t.slice(1) : "Untitled clip";
}

const STOP = new Set(
  "the a an and or but so to of in on for with is are was were be been it its this that i you we they he she my your our their me us them at as by from not do does did have has had just like really very can will would could should what about there here then than when if into out up down over more most some any all one get got know think going go".split(" "),
);

function terms(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function overlapTerms(text: string, want: Set<string>): number {
  if (!want.size) return 0;
  const have = terms(text);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.size;
}

function hashtagsFrom(text: string): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 5 || STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => `#${w}`);
}

// ---------------------------------------------------------------------------
// Heuristic judge

export interface Judged {
  hook: number;
  flow: number;
  value: number;
  trend: number;
  relevance: number | null;
  comments: { hook: string; flow: string; value: string; trend: string; relevance?: string };
}

interface RawFeat {
  hook: number;
  flow: number;
  value: number;
  trend: number;
  rel: number;
  notes: { hook: string; flow: string; value: string; trend: string };
}

function clipFeatures(ranges: Range[], ss: ClipSentence[]): RawFeat {
  const inClip = (s: ClipSentence) => ranges.some(([a, b]) => s.start >= a - 0.3 && s.end <= b + 0.3);
  const order: ClipSentence[] = [];
  for (const [a, b] of ranges) for (const s of ss) if (s.start >= a - 0.3 && s.end <= b + 0.3 && !order.includes(s)) order.push(s);
  const list = order.length ? order : ss.filter(inClip);
  if (!list.length) return { hook: 0, flow: 0, value: 0, trend: 0, rel: 0, notes: { hook: "", flow: "", value: "", trend: "" } };
  const f = list.map(sentenceFeatures);
  const first = f[0];
  const last = f[f.length - 1];
  const fill = f.reduce((x, y) => x + y.filler, 0) / f.length;
  const dur = rangesDuration(ranges);
  const val = f.reduce((x, y) => x + y.value, 0) / Math.max(1, dur / 15);
  const trd = f.reduce((x, y) => x + y.trend, 0);
  const hook = first.hook + (first.claim ? 1 : 0) - (first.dangling ? 3 : 0);
  const flow = (first.dangling ? 0 : 2) + (last.complete ? 2 : 0) - fill * 6 - Math.max(0, ranges.length - 2) * 0.5;
  return {
    hook,
    flow,
    value: val,
    trend: trd,
    rel: 0,
    notes: {
      hook: /\?\s*$/.test(list[0].text) ? "Opens on a question." : first.claim ? "Opens on a bold claim." : first.dangling ? "Opens mid-thought." : "Plain opener; a sharper first line would help.",
      flow: last.complete && !first.dangling ? (ranges.length > 1 ? "Stitched cleanly; ends on a complete line." : "Self-contained, ends on a complete line.") : "Ending trails off.",
      value: val >= 1.5 ? "Concrete specifics throughout." : val >= 0.7 ? "Some specifics; a number would help." : "Light on takeaways.",
      trend: trd >= 3 ? "Topic is in a busy niche right now." : trd >= 1 ? "Touches a popular topic." : "Evergreen, not trend-driven.",
    },
  };
}

/**
 * Sub-scores for a batch of clips. Raw features are spread by rank across
 * the batch onto 4-9, so a job always shows a usable spread instead of a
 * wall of identical 6s.
 */
export function heuristicJudge(clips: { ranges: Range[]; text?: string }[], ss: ClipSentence[], prompt?: string): Judged[] {
  const feats = clips.map((c) => clipFeatures(c.ranges, ss));
  const want = terms(prompt ?? "");
  if (want.size) {
    clips.forEach((c, i) => {
      const text = c.text ?? ss.filter((s) => c.ranges.some(([a, b]) => s.start >= a - 0.3 && s.end <= b + 0.3)).map((s) => s.text).join(" ");
      feats[i].rel = overlapTerms(text, want);
    });
  }
  const spread = (key: "hook" | "flow" | "value" | "trend") => {
    const vals = feats.map((f) => f[key]);
    return vals.map((v) => {
      if (vals.length < 2) return 7;
      const below = vals.filter((x) => x < v).length;
      const eq = vals.filter((x) => x === v).length - 1;
      return Math.round(4 + (5 * (below + eq / 2)) / (vals.length - 1));
    });
  };
  const H = spread("hook");
  const F = spread("flow");
  const V = spread("value");
  const T = spread("trend");
  return feats.map((f, i) => ({
    hook: H[i],
    flow: F[i],
    value: V[i],
    trend: T[i],
    relevance: want.size ? Math.round(10 * Math.min(1, f.rel * 1.5)) : null,
    comments: {
      ...f.notes,
      ...(want.size ? { relevance: f.rel >= 0.5 ? "Matches the prompt." : f.rel > 0 ? "Loosely matches the prompt." : "Off the prompt." } : {}),
    },
  }));
}

/** Grow or shrink a clip by one sentence at its start or end. */
export function nudgeRanges(ranges: Range[], ss: ClipSentence[], edge: "start" | "end", dir: "extend" | "shrink"): Range[] {
  if (!ranges.length || !ss.length) return ranges;
  const out = ranges.map((r) => [r[0], r[1]] as Range);
  const r = edge === "start" ? out[0] : out[out.length - 1];
  if (edge === "start") {
    if (dir === "extend") {
      const prev = [...ss].reverse().find((s) => s.end <= r[0] + 0.3);
      if (prev) r[0] = prev.start;
    } else {
      const inside = ss.filter((s) => s.start >= r[0] - 0.3 && s.end <= r[1] + 0.3);
      if (inside.length > 1) r[0] = inside[1].start;
    }
  } else if (dir === "extend") {
    const next = ss.find((s) => s.start >= r[1] - 0.3);
    if (next) r[1] = next.end;
  } else {
    const inside = ss.filter((s) => s.start >= r[0] - 0.3 && s.end <= r[1] + 0.3);
    if (inside.length > 1) r[1] = inside[inside.length - 2].end;
  }
  return out;
}

/** ClipSentence index span covering [start, end] seconds (refine). */
export function sentenceSpan(ss: ClipSentence[], start: number, end: number): { from: number; to: number } | null {
  const from = ss.findIndex((s) => s.end > start);
  let to = -1;
  for (let k = ss.length - 1; k >= 0; k--) if (ss[k].start < end) { to = k; break; }
  return from >= 0 && to >= from ? { from, to } : null;
}

// ---------------------------------------------------------------------------
// Seeding: a candidate as a ready edit doc.


/**
 * One clip per range, in play order, all cut from the same source. Shots
 * (auto reframe, source time) carry over keyed by the new asset; captions
 * stay on, so the editor opens a candidate already framed and captioned.
 */
export function seedClipDoc(
  assetId: string,
  ranges: Range[],
  opts: { shots?: Shot[]; facesKey?: string; aspect?: EditDoc["output"]["aspect"]; name?: string } = {},
): EditDoc {
  const doc = emptyDoc([]);
  // Same ids newClipId would hand out: the asset id, then asset~2, asset~3.
  doc.clips = ranges.map(([s, e], k) => ({ id: k === 0 ? assetId : `${assetId}~${k + 1}`, assetId, srcIn: s, srcOut: e }));
  if (opts.aspect) doc.output = { ...doc.output, aspect: opts.aspect };
  if (opts.shots?.length) doc.shots = { [assetId]: opts.shots };
  if (opts.facesKey) doc.faces = { [assetId]: opts.facesKey };
  if (opts.name) doc.export = { ...doc.export, name: opts.name };
  return doc;
}
