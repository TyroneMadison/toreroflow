/**
 * EDL, the ordered list of source segments that make the output.
 * Maps output time to source time and back. Pure, side-effect-free.
 */

import { normalizeCuts, type EditDoc } from "./editDoc";
import type { Word } from "./autoCut";

export interface EdlSegment {
  assetId: string;
  /** The v2 main-track clip this piece came from (keys doc.layout). */
  clipId?: string;
  srcIn: number;
  srcOut: number;
}

/** Segments shorter than this are dropped, they only cause seek churn. */
const MIN_SEGMENT_SEC = 0.05;

/**
 * Walks doc.clips in order (play order, which may differ from source order).
 * Each clip segment [srcIn, min(srcOut, duration)] minus its asset's
 * normalized cuts, in source order inside the segment. Cuts stay keyed by
 * asset in source time, so word edits survive re-segmenting. Clips with no
 * known duration are skipped.
 */
export function edlFromDoc(doc: EditDoc, durations: Record<string, number>): EdlSegment[] {
  const out: EdlSegment[] = [];
  for (const clip of doc.clips) {
    const { assetId } = clip;
    const duration = durations[assetId];
    if (!(duration > 0)) continue;
    const lo = Math.max(0, clip.srcIn ?? 0);
    const hi = Math.min(duration, clip.srcOut ?? duration);
    if (!(hi > lo)) continue;
    const cuts = normalizeCuts(doc.cuts[assetId] ?? [], duration);
    let cursor = lo;
    for (const c of cuts) {
      if (c.end <= lo) continue;
      if (c.start >= hi) break;
      if (c.start - cursor >= MIN_SEGMENT_SEC) {
        out.push({ assetId, clipId: clip.id, srcIn: cursor, srcOut: c.start });
      }
      cursor = Math.max(cursor, c.end);
    }
    if (hi - cursor >= MIN_SEGMENT_SEC) {
      out.push({ assetId, clipId: clip.id, srcIn: cursor, srcOut: hi });
    }
  }
  return out;
}

export function outputDuration(edl: EdlSegment[]): number {
  return edl.reduce((sum, s) => sum + (s.srcOut - s.srcIn), 0);
}

/**
 * Segment and source time at an output time. Segments are half open, a time
 * on a boundary belongs to the following segment. Null outside the output.
 */
export function locate(
  edl: EdlSegment[],
  outputTime: number,
): { segIndex: number; assetId: string; clipId?: string; srcTime: number } | null {
  if (outputTime < 0) return null;
  let acc = 0;
  for (let i = 0; i < edl.length; i++) {
    const len = edl[i].srcOut - edl[i].srcIn;
    if (outputTime < acc + len) {
      const hit = { segIndex: i, assetId: edl[i].assetId, srcTime: edl[i].srcIn + (outputTime - acc) };
      return edl[i].clipId === undefined ? hit : { ...hit, clipId: edl[i].clipId };
    }
    acc += len;
  }
  return null;
}

/**
 * Transcript words remapped to OUTPUT time through the EDL, in output order.
 * A word survives only when it sits fully inside a kept segment, so words
 * inside cuts (or straddling a cut edge) are dropped.
 */
export function outputWords(edl: EdlSegment[], wordsByAsset: Record<string, Word[]>): Word[] {
  const out: Word[] = [];
  let acc = 0;
  // The epsilon forgives float noise on cut boundaries carved from word times.
  const eps = 1e-6;
  for (const seg of edl) {
    for (const w of wordsByAsset[seg.assetId] ?? []) {
      if (w.start >= seg.srcIn - eps && w.end <= seg.srcOut + eps) {
        out.push({
          start: acc + Math.max(0, w.start - seg.srcIn),
          end: acc + Math.max(0, w.end - seg.srcIn),
          word: w.word,
        });
      }
    }
    acc += seg.srcOut - seg.srcIn;
  }
  return out;
}

/** Output time for a source time on an asset, null when it falls inside a cut. */
export function toOutputTime(
  edl: EdlSegment[],
  assetId: string,
  srcTime: number,
  clipId?: string,
): number | null {
  let acc = 0;
  for (const seg of edl) {
    if (
      seg.assetId === assetId &&
      (clipId === undefined || seg.clipId === clipId) &&
      srcTime >= seg.srcIn &&
      srcTime < seg.srcOut
    ) {
      return acc + (srcTime - seg.srcIn);
    }
    acc += seg.srcOut - seg.srcIn;
  }
  return null;
}
