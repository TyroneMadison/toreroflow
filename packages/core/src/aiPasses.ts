/**
 * Phase 5 AI editing passes, heuristic and free. Every pass reads the words
 * that survive the current cut (through the EDL) and answers in word
 * indices per asset, so suggestions stay valid after later cuts: cuts are
 * source ranges carved from word times, highlights key word indices, and
 * zoom/b-roll items carry a word anchor that reanchorDoc maps back to output
 * time.
 *
 * ponytail: rules, not a model. The spec routes are the swap point for an
 * LLM later; today every answer comes from these functions so no AI spend.
 */
import { lowerThirdItems } from "./polish";
import type { Word } from "./autoCut";
import type { EditDoc, TextItem, TextStyle, ZoomItem } from "./editDoc";
import { DEFAULT_TEXT_STYLE } from "./editDoc";
import { edlFromDoc, type EdlSegment } from "./edl";
import { FILLER_PHRASES, FILLER_SINGLE } from "./words";

/** One surviving word with its source address and output time. */
export interface WordRef {
  assetId: string;
  i: number;
  word: string;
  /** Source time. */
  start: number;
  end: number;
  /** Output time. */
  outStart: number;
  outEnd: number;
}

/** Word address that survives later cuts. */
export interface WordAnchor {
  assetId: string;
  i: number;
}

const EPS = 1e-6;

/** Same filter and order as edl.outputWords, plus each word's source address. */
export function outputWordRefs(edl: EdlSegment[], wordsByAsset: Record<string, Word[]>): WordRef[] {
  const out: WordRef[] = [];
  let acc = 0;
  for (const seg of edl) {
    const list = wordsByAsset[seg.assetId] ?? [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.start >= seg.srcIn - EPS && w.end <= seg.srcOut + EPS) {
        out.push({
          assetId: seg.assetId,
          i,
          word: w.word,
          start: w.start,
          end: w.end,
          outStart: acc + Math.max(0, w.start - seg.srcIn),
          outEnd: acc + Math.max(0, w.end - seg.srcIn),
        });
      }
    }
    acc += seg.srcOut - seg.srcIn;
  }
  return out;
}

export function bareWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

/* ------------------------------------------------------------------ */
/* Speech cleanup                                                       */
/* ------------------------------------------------------------------ */

export type CleanupKind = "filler" | "pause" | "badtake";

export interface CleanupItem {
  id: string;
  kind: CleanupKind;
  /** Filler phrase ("you know"), pause length ("0.8s"), or the dropped take. */
  label: string;
  /** What survives, for bad takes: the retake the cut keeps. */
  keep?: string;
  assetId: string;
  /** Word index range [i0, i1] removed; pauses use the two words around the gap. */
  i0: number;
  i1: number;
  /** Source range to cut. */
  start: number;
  end: number;
}

export interface CleanupOptions {
  pauseSec?: number;
  /** Filler entries; multi-word ones as space separated phrases. */
  fillers?: string[];
  /** Silence kept on each side of a cut pause. */
  padSec?: number;
}

export const DEFAULT_FILLERS: string[] = [
  ...FILLER_SINGLE,
  ...FILLER_PHRASES.map((p) => p.join(" ")),
];

function fillerHits(refs: WordRef[], fillers: string[]): CleanupItem[] {
  const phrases = fillers
    .map((f) => f.toLowerCase().split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  const out: CleanupItem[] = [];
  let k = 0;
  while (k < refs.length) {
    let hit: string[] | null = null;
    for (const p of phrases) {
      if (k + p.length > refs.length) continue;
      let ok = true;
      for (let j = 0; j < p.length; j++) {
        const r = refs[k + j];
        if (bareWord(r.word) !== p[j] || r.assetId !== refs[k].assetId || r.i !== refs[k].i + j) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hit = p;
        break;
      }
    }
    if (!hit) {
      k++;
      continue;
    }
    const a = refs[k];
    const b = refs[k + hit.length - 1];
    out.push({
      id: `f:${a.assetId}:${a.i}`,
      kind: "filler",
      label: hit.join(" "),
      assetId: a.assetId,
      i0: a.i,
      i1: b.i,
      start: a.start,
      end: b.end,
    });
    k += hit.length;
  }
  return out;
}

function pauseHits(refs: WordRef[], minSec: number, pad: number): CleanupItem[] {
  const out: CleanupItem[] = [];
  for (let k = 1; k < refs.length; k++) {
    const a = refs[k - 1];
    const b = refs[k];
    if (a.assetId !== b.assetId || b.i !== a.i + 1) continue;
    const gap = b.start - a.end;
    if (gap < minSec || gap <= 2 * pad) continue;
    out.push({
      id: `p:${a.assetId}:${a.i}`,
      kind: "pause",
      label: `${gap.toFixed(1)}s`,
      assetId: a.assetId,
      i0: a.i,
      i1: b.i,
      start: a.end + pad,
      end: b.start - pad,
    });
  }
  return out;
}

/**
 * Bad takes: a run of n >= 2 words (or one word, a stutter)
 * that the speaker repeats right after (a lone word only within 0.6 s), within a short window. The earlier
 * take goes, the retake stays. Fillers between the takes go with it.
 */
function badTakeHits(refs: WordRef[], fillers: Set<string>): CleanupItem[] {
  const out: CleanupItem[] = [];
  const MAX_N = 6;
  const WINDOW_SEC = 6;
  let k = 0;
  while (k < refs.length) {
    let found: CleanupItem | null = null;
    for (let n = MAX_N; n >= 1 && !found; n--) {
      if (k + n > refs.length) continue;
      const take = refs.slice(k, k + n).map((r) => bareWord(r.word));
      if (take.some((t) => !t)) continue;
      if (n === 1 && fillers.has(take[0])) continue;
      // Skip fillers/pause between the takes, up to 3 words.
      for (let gap = 0; gap <= 3 && !found; gap++) {
        const s = k + n + gap;
        if (s + n > refs.length) break;
        if (gap > 0 && !fillers.has(bareWord(refs[s - 1].word))) break;
        const retake = refs.slice(s, s + n).map((r) => bareWord(r.word));
        if (retake.join(" ") !== take.join(" ")) continue;
        const a = refs[k];
        const last = refs[s - 1];
        const keepEnd = refs[Math.min(refs.length - 1, s + n - 1)];
        if (keepEnd.start - a.start > WINDOW_SEC) continue;
        // A single repeated word only counts as a stutter when tight.
        if (n === 1 && refs[s].start - refs[k].end > 0.6) continue;
        if (last.assetId !== a.assetId || last.i - a.i !== s - 1 - k) continue;
        found = {
          id: `b:${a.assetId}:${a.i}`,
          kind: "badtake",
          label: refs.slice(k, s).map((r) => r.word).join(" "),
          keep: refs.slice(s, Math.min(refs.length, s + n + 2)).map((r) => r.word).join(" "),
          assetId: a.assetId,
          i0: a.i,
          i1: last.i,
          start: a.start,
          end: refs[s].start,
        };
      }
    }
    if (found) {
      out.push(found);
      k += found.i1 - found.i0 + 1;
    } else k++;
  }
  return out;
}

export interface CleanupScan {
  fillers: CleanupItem[];
  pauses: CleanupItem[];
  badTakes: CleanupItem[];
}

/** Everything the cleanup panel lists, over the words still in the cut. */
export function speechCleanup(refs: WordRef[], opts: CleanupOptions = {}): CleanupScan {
  const fillers = opts.fillers ?? DEFAULT_FILLERS;
  const singles = new Set(
    fillers.filter((f) => !/\s/.test(f.trim())).map((f) => f.trim().toLowerCase()),
  );
  const badTakes = badTakeHits(refs, singles);
  const fillerItems = fillerHits(refs, fillers).filter(
    (f) => !badTakes.some((b) => b.assetId === f.assetId && f.i0 >= b.i0 && f.i1 <= b.i1),
  );
  return {
    fillers: fillerItems,
    pauses: pauseHits(refs, opts.pauseSec ?? 0.6, opts.padSec ?? 0.1),
    badTakes,
  };
}

/** Filler counts by phrase, most frequent first, for the chip row. */
export function fillerCounts(items: CleanupItem[]): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) if (it.kind === "filler") m.set(it.label, (m.get(it.label) ?? 0) + 1);
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* Hook headline                                                        */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  (
    "a an the and or but so to of in on at for with by from as is are was were be been being " +
    "i me my we our you your he she it its they them their this that these those there here " +
    "do does did have has had will would can could should just like really very then than " +
    "what when where who how which if not no yes also about into out up down over get got " +
    "go going gonna am im i'm it's that's don't dont i've you're we're they're thing things " +
    "know mean right okay ok yeah well um uh"
  ).split(" "),
);

const POWER = new Set(
  (
    "never always stop secret mistake truth why how money best worst only first last " +
    "nobody everyone everybody biggest hardest easiest fastest broke rich hire hired fired " +
    "quit failed fail lost won win wrong free dollars million thousand crazy insane " +
    "regret warning hate love simple real"
  ).split(" "),
);

export function isContentWord(w: string): boolean {
  const b = bareWord(w);
  return /^\d+$/.test(b) || (b.length >= 3 && !STOP.has(b));
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

interface Sentence {
  refs: WordRef[];
}

function sentences(refs: WordRef[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: WordRef[] = [];
  for (let k = 0; k < refs.length; k++) {
    const r = refs[k];
    const prev = refs[k - 1];
    if (cur.length > 0 && prev && r.start - prev.end > 0.7) {
      out.push({ refs: cur });
      cur = [];
    }
    cur.push(r);
    if (/[.!?]$/.test(r.word) || cur.length >= 24) {
      out.push({ refs: cur });
      cur = [];
    }
  }
  if (cur.length) out.push({ refs: cur });
  return out;
}

export interface HookSuggestion {
  text: string;
  /** Source of the line: the first word it came from. */
  from: WordAnchor;
}

/**
 * Up to 3 headline candidates, best first. A candidate is a 3-8 word
 * window from a sentence, scored on power words, content density, a
 * "you"/question shape, and earliness (hooks come from the opening).
 */
export function suggestHooks(refs: WordRef[], max = 3): HookSuggestion[] {
  if (refs.length === 0) return [];
  const total = refs[refs.length - 1].outEnd || 1;
  const scored: { score: number; text: string; from: WordAnchor; to: number }[] = [];
  for (const s of sentences(refs)) {
    const ws = s.refs.filter((r) => !FILLER_SINGLE.includes(bareWord(r.word)));
    if (ws.length < 3) continue;
    for (let a = 0; a < ws.length; a++) {
      // Lead with a content word, never a joiner.
      if (STOP.has(bareWord(ws[a].word)) && !POWER.has(bareWord(ws[a].word)) && bareWord(ws[a].word) !== "why" && bareWord(ws[a].word) !== "how") continue;
      for (let len = 3; len <= 7 && a + len <= ws.length; len++) {
        const win = ws.slice(a, a + len);
        const last = bareWord(win[win.length - 1].word);
        if (STOP.has(last)) continue;
        const words = win.map((r) => bareWord(r.word));
        const power = words.filter((w) => POWER.has(w)).length;
        const content = words.filter((w) => !STOP.has(w)).length / len;
        const early = 1 - Math.min(1, win[0].outStart / total);
        const sizeFit = len >= 4 && len <= 6 ? 0.5 : 0;
        // A headline is a phrase: no comma inside, and it should close a clause.
        if (win.slice(0, -1).some((r) => /[,;:]$/.test(r.word))) continue;
        const closes = /[.,!?;:]$/.test(win[win.length - 1].word) || a + len === ws.length ? 1 : 0;
        const score = power * 2 + content * 2 + early * 1.5 + sizeFit + closes;
        scored.push({
          score,
          text: titleCase(win.map((r) => r.word.replace(/[^\p{L}\p{N}'$%]/gu, "")).join(" ")),
          from: { assetId: win[0].assetId, i: win[0].i },
          to: win[win.length - 1].i,
        });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const out: HookSuggestion[] = [];
  const used: { assetId: string; i0: number; i1: number }[] = [];
  for (const c of scored) {
    // Alternatives come from different stretches, not shifted windows.
    if (used.some((u) => u.assetId === c.from.assetId && c.from.i <= u.i1 && c.to >= u.i0)) continue;
    used.push({ assetId: c.from.assetId, i0: c.from.i, i1: c.to });
    out.push({ text: c.text, from: c.from });
    if (out.length >= max) break;
  }
  return out;
}

/** Spec style: black heavy text on a white rounded box, top third. */
export const HOOK_STYLE: TextStyle = {
  ...DEFAULT_TEXT_STYLE,
  font: "Montserrat",
  bold: true,
  color: "#000000",
  size: 54,
  y: -30,
  case: "asis",
  outline: { on: false, size: 0, color: "#000000", distance: 0 },
  background: { on: true, shape: "rounded", opacity: 100, size: 50, color: "#FFFFFF" },
};

export const HOOK_DUR = 5;

/** The hook as a plain TextItem at 0, so render and preview reuse the text path. */
export function hookAsText(doc: EditDoc): TextItem | null {
  const h = doc.hook;
  if (!h || !h.text.trim()) return null;
  return {
    id: "__hook",
    at: 0,
    dur: h.dur,
    content: h.text,
    x: h.style.x,
    y: h.style.y,
    style: h.style,
    animIn: "pop",
    animOut: "none",
  };
}

/** doc.texts plus the hook and any Phase 7 lower thirds, the list renderers draw. */
export function textsWithHook(doc: EditDoc): TextItem[] {
  const h = hookAsText(doc);
  const base = h ? [h, ...doc.texts] : doc.texts;
  const lts = lowerThirdItems(doc);
  return lts.length ? [...base, ...lts] : base;
}

/* ------------------------------------------------------------------ */
/* Keyword highlights + emojis                                          */
/* ------------------------------------------------------------------ */

export const EMOJI_DICT: Record<string, string> = {
  money: "💰", dollars: "💵", dollar: "💵", cash: "💵", paid: "💵", pay: "💵", payroll: "💵",
  rich: "🤑", broke: "😬", love: "❤️", hate: "😤", fire: "🔥", hot: "🔥", crazy: "🤯",
  insane: "🤯", idea: "💡", think: "💡", secret: "🤫", time: "⏰", phone: "📱", call: "📞",
  calls: "📞", called: "📞", house: "🏠", home: "🏠", rent: "🏠", car: "🚗", work: "💼",
  job: "💼", hire: "🤝", hired: "🤝", deal: "🤝", family: "👨‍👩‍👧", cousin: "👨‍👩‍👧", win: "🏆",
  won: "🏆", best: "🏆", growth: "📈", grow: "📈", up: "📈", down: "📉", lost: "📉",
  mistake: "❌", wrong: "❌", never: "🚫", stop: "🛑", happy: "😄", funny: "😂", laugh: "😂",
  sad: "😢", scared: "😱", warning: "⚠️", book: "📚", learn: "📚", school: "🎓", food: "🍔",
  coffee: "☕", world: "🌍", fast: "⚡", quick: "⚡", strong: "💪", hard: "💪", hardest: "💪",
  goal: "🎯", target: "🎯", question: "❓", why: "🤔", heart: "❤️", trust: "🤝",
};

export interface HighlightSuggestion {
  keywords: Record<string, Record<number, 1 | 2>>;
  emojis: Record<string, Record<number, string>>;
}

/**
 * About 6% of words at level 1 (accent) and 4% at level 2 (strong), picked
 * from content words by rarity in this talk and power words first; emojis
 * about one per 20 seconds from EMOJI_DICT, at least 6 seconds apart.
 */
export function suggestHighlights(refs: WordRef[]): HighlightSuggestion {
  const keywords: HighlightSuggestion["keywords"] = {};
  const emojis: HighlightSuggestion["emojis"] = {};
  if (refs.length === 0) return { keywords, emojis };
  const freq = new Map<string, number>();
  for (const r of refs) freq.set(bareWord(r.word), (freq.get(bareWord(r.word)) ?? 0) + 1);
  const cand = refs
    .map((r, k) => {
      const b = bareWord(r.word);
      if (b.length < 3 || STOP.has(b) || FILLER_SINGLE.includes(b)) return null;
      const score =
        (POWER.has(b) ? 3 : 0) +
        (/^\d|[$%]/.test(r.word) ? 2.5 : 0) +
        Math.min(2, b.length / 4) +
        1 / (freq.get(b) ?? 1) +
        (/[!?]$/.test(r.word) ? 0.5 : 0);
      return { k, r, score };
    })
    .filter((c): c is { k: number; r: WordRef; score: number } => c !== null)
    .sort((a, b) => b.score - a.score || a.k - b.k);
  const n2 = Math.max(1, Math.round(refs.length * 0.04));
  const n1 = Math.max(1, Math.round(refs.length * 0.06));
  const taken = new Set<number>();
  const put = (c: { k: number; r: WordRef }, lvl: 1 | 2) => {
    // Never two marks in a row: one per breath reads as emphasis.
    if (taken.has(c.k) || taken.has(c.k - 1) || taken.has(c.k + 1)) return false;
    taken.add(c.k);
    (keywords[c.r.assetId] ??= {})[c.r.i] = lvl;
    return true;
  };
  let c2 = 0;
  let c1 = 0;
  for (const c of cand) {
    if (c2 < n2) {
      if (put(c, 2)) c2++;
    } else if (c1 < n1) {
      if (put(c, 1)) c1++;
    } else break;
  }
  const total = refs[refs.length - 1].outEnd;
  const maxEmoji = Math.max(1, Math.round(total / 20));
  const emojiCands = refs
    .map((r, k) => ({ r, k, e: EMOJI_DICT[bareWord(r.word)] }))
    .filter((c) => c.e)
    .sort((a, b) => (taken.has(b.k) ? 1 : 0) - (taken.has(a.k) ? 1 : 0) || a.k - b.k);
  const placed: number[] = [];
  for (const c of emojiCands) {
    if (placed.length >= maxEmoji) break;
    if (placed.some((t) => Math.abs(t - c.r.outStart) < 6)) continue;
    placed.push(c.r.outStart);
    (emojis[c.r.assetId] ??= {})[c.r.i] = c.e!;
  }
  return { keywords, emojis };
}

/** Per output word, its highlight level and emoji, parallel to refs. */
export function wordMarks(
  refs: WordRef[],
  doc: EditDoc,
): { level: 0 | 1 | 2; emoji?: string }[] {
  const h = doc.captions.highlight;
  return refs.map((r) => ({
    level: (h?.keywords[r.assetId]?.[r.i] ?? 0) as 0 | 1 | 2,
    emoji: h?.emojis[r.assetId]?.[r.i],
  }));
}

/** Level 2 color: a fixed warm yellow that reads on any accent. */
export const HIGHLIGHT_STRONG = "#FFD84D";

/* ------------------------------------------------------------------ */
/* Auto zoom                                                            */
/* ------------------------------------------------------------------ */

export type ZoomPreset = "slow_push" | "punch_in" | "quick_zoom";

/** Curves in seconds from item start. slow_push: 1 -> 1.18 over 3s, hold 1s, out 0.2s. */
export const ZOOM_CURVES: Record<ZoomPreset, { t: number; scale: number }[]> = {
  slow_push: [
    { t: 0, scale: 1 },
    { t: 3, scale: 1.18 },
    { t: 4, scale: 1.18 },
    { t: 4.2, scale: 1 },
  ],
  punch_in: [
    { t: 0, scale: 1 },
    { t: 0.08, scale: 1.3 },
    { t: 1.6, scale: 1.3 },
    { t: 1.7, scale: 1 },
  ],
  quick_zoom: [
    { t: 0, scale: 1 },
    { t: 0.15, scale: 1.4 },
    { t: 0.75, scale: 1.4 },
    { t: 0.9, scale: 1 },
  ],
};

/** Scale on a curve dt seconds after start; 1 outside it. */
export function curveScale(curve: { t: number; scale: number }[], dt: number): number {
  if (curve.length === 0 || dt < curve[0].t || dt > curve[curve.length - 1].t) return 1;
  for (let k = 1; k < curve.length; k++) {
    const a = curve[k - 1];
    const b = curve[k];
    if (dt <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.scale : a.scale + (b.scale - a.scale) * ((dt - a.t) / span);
    }
  }
  return curve[curve.length - 1].scale;
}

export interface ZoomSuggestion {
  word: WordAnchor;
  label: string;
  preset: ZoomPreset;
  /** Output time now, for display. */
  at: number;
}

/**
 * About one zoom per 30 seconds, at least 8 seconds apart, on the strongest
 * emphasis words (power words, numbers, ends of exclamations). Punch-in on
 * the very strongest, slow push on the rest.
 */
export function suggestZooms(refs: WordRef[]): ZoomSuggestion[] {
  if (refs.length === 0) return [];
  const total = refs[refs.length - 1].outEnd;
  const want = Math.max(1, Math.round(total / 30));
  const scored = refs
    .map((r) => {
      const b = bareWord(r.word);
      if (b.length < 2 || STOP.has(b) || FILLER_SINGLE.includes(b)) return null;
      const s =
        (POWER.has(b) ? 3 : 0) +
        (/^\d|[$%]/.test(r.word) ? 2 : 0) +
        (/[!]$/.test(r.word) ? 2 : 0) +
        (/[?]$/.test(r.word) ? 1 : 0) +
        Math.min(1.5, b.length / 5);
      return { r, s };
    })
    .filter((x): x is { r: WordRef; s: number } => x !== null)
    .sort((a, b) => b.s - a.s || a.r.outStart - b.r.outStart);
  const picked: { r: WordRef; s: number }[] = [];
  for (const c of scored) {
    if (picked.length >= want) break;
    if (c.r.outStart < 0.5) continue;
    if (picked.some((p) => Math.abs(p.r.outStart - c.r.outStart) < 8)) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.r.outStart - b.r.outStart);
  const top = Math.max(...picked.map((p) => p.s));
  return picked.map((p) => ({
    word: { assetId: p.r.assetId, i: p.r.i },
    label: bareWord(p.r.word),
    preset: p.s >= top && p.s >= 4 ? "punch_in" : "slow_push",
    at: p.r.outStart,
  }));
}

/** A ZoomItem for a suggestion: curve expanded, anchored on the face. */
export function zoomItemFor(s: ZoomSuggestion, id: string): ZoomItem & { word: WordAnchor } {
  return {
    id,
    at: s.at,
    kind: s.preset === "slow_push" ? "pushin" : s.preset === "punch_in" ? "punchin" : "quickzoom",
    size: "m",
    curve: ZOOM_CURVES[s.preset].map((p) => ({ ...p })),
    anchor: "face",
    word: s.word,
  };
}

/* ------------------------------------------------------------------ */
/* B-roll spots                                                         */
/* ------------------------------------------------------------------ */

export interface BrollSpotSuggestion {
  id: string;
  label: string;
  keywords: string[];
  word: WordAnchor;
  /** Last word of the span, same asset. */
  endI: number;
  at: number;
  dur: number;
}

/**
 * Concrete-noun moments b-roll can show: windows of 2-4 s whose words are
 * content-dense and include an EMOJI_DICT noun or a long content word,
 * one per ~15 seconds, at least 8 seconds apart, never in the first 2 s
 * (the hook owns the face there).
 */
export function suggestBrollSpots(refs: WordRef[]): BrollSpotSuggestion[] {
  if (refs.length === 0) return [];
  const total = refs[refs.length - 1].outEnd;
  const want = Math.max(1, Math.round(total / 15));
  const cands: { k: number; s: number; kws: string[] }[] = [];
  for (let k = 0; k < refs.length; k++) {
    const r = refs[k];
    const b = bareWord(r.word);
    if (r.outStart < 2 || STOP.has(b) || b.length < 4) continue;
    const kws: string[] = [];
    let s = 0;
    for (let j = Math.max(0, k - 3); j <= Math.min(refs.length - 1, k + 3); j++) {
      const bj = bareWord(refs[j].word);
      if (bj.length >= 4 && !STOP.has(bj) && !kws.includes(bj)) {
        kws.push(bj);
        s += EMOJI_DICT[bj] ? 2 : 0.5;
      }
    }
    if (EMOJI_DICT[b]) s += 2;
    cands.push({ k, s, kws: kws.slice(0, 3) });
  }
  cands.sort((a, b) => b.s - a.s || a.k - b.k);
  const out: BrollSpotSuggestion[] = [];
  for (const c of cands) {
    if (out.length >= want) break;
    const r = refs[c.k];
    if (out.some((o) => Math.abs(o.at - r.outStart) < 8)) continue;
    // Span: from this word up to 3 s, same asset and contiguous.
    let e = c.k;
    while (
      e + 1 < refs.length &&
      refs[e + 1].assetId === r.assetId &&
      refs[e + 1].i === refs[e].i + 1 &&
      refs[e + 1].outEnd - r.outStart <= 3
    )
      e++;
    const dur = Math.max(1.5, refs[e].outEnd - r.outStart);
    out.push({
      id: `s:${r.assetId}:${r.i}`,
      label: refs.slice(c.k, e + 1).map((x) => x.word).join(" "),
      keywords: c.kws,
      word: { assetId: r.assetId, i: r.i },
      endI: refs[e].i,
      at: r.outStart,
      dur,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ */
/* Re-anchoring after later cuts                                         */
/* ------------------------------------------------------------------ */


/**
 * Moves every zoom and b-roll item that carries a word anchor to that word's
 * current output time. Items whose word was cut stay where they are. Same
 * reference back when nothing moved.
 */
export function reanchorDoc(
  doc: EditDoc,
  durations: Record<string, number>,
  wordsByAsset: Record<string, Word[]>,
): EditDoc {
  const edl = edlFromDoc(doc, durations);
  const refs = outputWordRefs(edl, wordsByAsset);
  const pos = new Map<string, number>();
  for (const r of refs) pos.set(`${r.assetId}:${r.i}`, r.outStart);
  let changed = false;
  const move = <T extends { at: number; word?: WordAnchor }>(it: T): T => {
    if (!it.word) return it;
    const at = pos.get(`${it.word.assetId}:${it.word.i}`);
    if (at === undefined || Math.abs(at - it.at) < 1e-3) return it;
    changed = true;
    return { ...it, at: Math.round(at * 1000) / 1000 };
  };
  const zooms = doc.zooms.map(move);
  const broll = doc.broll.map(move);
  return changed ? { ...doc, zooms, broll } : doc;
}

/** Chunks with their words' keyword levels and emojis, packed the same way. */
export function attachMarks<C extends { text: string }>(
  chunks: C[],
  marks: { level: 0 | 1 | 2; emoji?: string }[],
  perChunk: number,
): (C & { marks?: (0 | 1 | 2)[]; emojis?: string[] })[] {
  if (!marks.some((m) => m.level > 0 || m.emoji)) return chunks;
  return chunks.map((c, k) => {
    const slice = marks.slice(k * perChunk, (k + 1) * perChunk);
    const emojis = slice.map((m) => m.emoji).filter((e): e is string => !!e);
    return {
      ...c,
      marks: slice.map((m) => m.level),
      ...(emojis.length ? { emojis } : {}),
    };
  });
}
