/**
 * EDL, the ordered list of source segments that make the output.
 * Maps output time to source time and back. Pure, side-effect-free.
 */

import { normalizeCuts, type EditDoc } from "./editDoc";

export interface EdlSegment {
  assetId: string;
  srcIn: number;
  srcOut: number;
}

/** Segments shorter than this are dropped, they only cause seek churn. */
const MIN_SEGMENT_SEC = 0.05;

/**
 * Walks doc.clips in order. For each asset, the full [0, duration] minus its
 * normalized cuts, in source order. Clips with no known duration are skipped.
 */
export function edlFromDoc(doc: EditDoc, durations: Record<string, number>): EdlSegment[] {
  const out: EdlSegment[] = [];
  for (const { assetId } of doc.clips) {
    const duration = durations[assetId];
    if (!(duration > 0)) continue;
    const cuts = normalizeCuts(doc.cuts[assetId] ?? [], duration);
    let cursor = 0;
    for (const c of cuts) {
      if (c.start - cursor >= MIN_SEGMENT_SEC) {
        out.push({ assetId, srcIn: cursor, srcOut: c.start });
      }
      cursor = c.end;
    }
    if (duration - cursor >= MIN_SEGMENT_SEC) {
      out.push({ assetId, srcIn: cursor, srcOut: duration });
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
): { segIndex: number; assetId: string; srcTime: number } | null {
  if (outputTime < 0) return null;
  let acc = 0;
  for (let i = 0; i < edl.length; i++) {
    const len = edl[i].srcOut - edl[i].srcIn;
    if (outputTime < acc + len) {
      return { segIndex: i, assetId: edl[i].assetId, srcTime: edl[i].srcIn + (outputTime - acc) };
    }
    acc += len;
  }
  return null;
}

/** Output time for a source time on an asset, null when it falls inside a cut. */
export function toOutputTime(edl: EdlSegment[], assetId: string, srcTime: number): number | null {
  let acc = 0;
  for (const seg of edl) {
    if (seg.assetId === assetId && srcTime >= seg.srcIn && srcTime < seg.srcOut) {
      return acc + (srcTime - seg.srcIn);
    }
    acc += seg.srcOut - seg.srcIn;
  }
  return null;
}
