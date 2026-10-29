import { applyTemplate, addCut, setAspect, type Aspect, type CaptionStyle, type EditDoc } from "./editDoc";
import { edlFromDoc } from "./edl";
import type { Word } from "./autoCut";
import {
  HOOK_DUR,
  HOOK_STYLE,
  outputWordRefs,
  reanchorDoc,
  speechCleanup,
  suggestHighlights,
  suggestHooks,
  suggestZooms,
  zoomItemFor,
} from "./aiPasses";

/**
 * Phase 6 recipes: a client's saved house style, applied to a fresh clip in
 * one go (job create, batch render) or to the open clip as one undo step.
 * Everything here is the Phase 5 heuristics, so a recipe never spends money.
 */
export interface RecipeSettings {
  aspect?: Aspect;
  captions?: {
    enabled?: boolean;
    /** A CAPTION_TEMPLATES id. */
    template?: string;
    /** Applied over the template, e.g. colors and uppercase. */
    style?: Partial<CaptionStyle>;
  };
  ai?: {
    hook?: boolean;
    fillers?: boolean;
    pauses?: boolean;
    badTakes?: boolean;
    zooms?: boolean;
    highlights?: boolean;
    emojis?: boolean;
    pauseSec?: number;
  };
}

export interface RecipeChange {
  cuts: number;
  cutSec: number;
  hook: string | null;
  keywords: number;
  emojis: number;
  zooms: number;
}

/** One line for a recipe card, e.g. "9:16 · Karaoke · hook". */
export function recipeSummary(s: RecipeSettings): string {
  const parts: string[] = [];
  if (s.aspect) parts.push(s.aspect);
  if (s.captions?.template) parts.push(s.captions.template);
  const ai = s.ai ?? {};
  if (ai.hook) parts.push("hook");
  if (ai.fillers || ai.pauses || ai.badTakes) parts.push("cleanup");
  if (ai.zooms) parts.push("zoom");
  if (ai.emojis) parts.push("emojis");
  return parts.join(" · ");
}

/**
 * The recipe over a doc. Order matters: framing and captions first, then
 * the cleanup cuts, then hook/highlights/zooms over the words that are left
 * so their anchors point at kept words.
 */
export function applyRecipe(
  doc: EditDoc,
  s: RecipeSettings,
  durations: Record<string, number>,
  wordsByAsset: Record<string, Word[]>,
): { doc: EditDoc; change: RecipeChange } {
  const change: RecipeChange = { cuts: 0, cutSec: 0, hook: null, keywords: 0, emojis: 0, zooms: 0 };
  let d = doc;
  if (s.aspect) d = setAspect(d, s.aspect);
  if (s.captions?.template) d = applyTemplate(d, s.captions.template);
  if (s.captions?.style || s.captions?.enabled !== undefined) {
    d = {
      ...d,
      captions: {
        ...d.captions,
        ...(s.captions.enabled !== undefined ? { enabled: s.captions.enabled } : {}),
        style: { ...d.captions.style, ...(s.captions.style ?? {}) },
      },
    };
  }
  const ai = s.ai ?? {};
  const refs = () => outputWordRefs(edlFromDoc(d, durations), wordsByAsset);

  if (ai.fillers || ai.pauses || ai.badTakes) {
    const scan = speechCleanup(refs(), { pauseSec: ai.pauseSec ?? 0.6 });
    const items = [
      ...(ai.fillers ? scan.fillers : []),
      ...(ai.pauses ? scan.pauses : []),
      ...(ai.badTakes ? scan.badTakes : []),
    ];
    for (const c of items) {
      d = addCut(d, c.assetId, { start: c.start, end: c.end }, durations[c.assetId]);
      change.cuts++;
      change.cutSec += c.end - c.start;
    }
    change.cutSec = Math.round(change.cutSec * 100) / 100;
  }
  if (ai.hook) {
    const h = suggestHooks(refs(), 1)[0];
    if (h) {
      d = { ...d, hook: { text: h.text, dur: HOOK_DUR, style: HOOK_STYLE } };
      change.hook = h.text;
    }
  }
  if (ai.highlights || ai.emojis) {
    const hl = suggestHighlights(refs());
    const highlight = {
      keywords: ai.highlights ? hl.keywords : {},
      emojis: ai.emojis ? hl.emojis : {},
    };
    const count = (m: Record<string, Record<number, unknown>>) =>
      Object.values(m).reduce((n, x) => n + Object.keys(x).length, 0);
    change.keywords = count(highlight.keywords);
    change.emojis = count(highlight.emojis);
    d = { ...d, captions: { ...d.captions, highlight } };
  }
  if (ai.zooms) {
    const zs = suggestZooms(refs());
    change.zooms = zs.length;
    d = {
      ...d,
      zooms: [...d.zooms.filter((z) => !z.id.startsWith("az-")), ...zs.map((z, k) => zoomItemFor(z, `az-r${k}`))].sort(
        (a, b) => a.at - b.at,
      ),
    };
  }
  return { doc: reanchorDoc(d, durations, wordsByAsset), change };
}

/** Versions kept per project; the oldest go first. */
export const VERSION_CAP = 50;

/** Ids to delete so at most `cap` remain, oldest first (input newest-first or any order). */
export function versionsToPrune<T extends { id: string; createdAt: Date | string }>(rows: T[], cap = VERSION_CAP): string[] {
  const sorted = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return sorted.slice(cap).map((r) => r.id);
}

/** At most `limit` jobs at once, in input order; results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** EDIT_CONCURRENCY: a whole number from 1 to max, else the fallback. */
export function parseConcurrency(raw: string | undefined, fallback = 1, max = 4): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}
