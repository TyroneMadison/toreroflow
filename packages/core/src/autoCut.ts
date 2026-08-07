/**
 * Auto cut proposals from transcript words. Pure, side-effect-free.
 * Ranges are SOURCE time on one asset, ready to feed addCut.
 */

import type { CutRange } from "./editDoc";

export interface Word {
  start: number;
  end: number;
  word: string;
}

export const FILLER_WORDS: string[] = ["um", "uh", "er", "uhm", "erm"];

/** Padding kept on each side of a silence so speech never clips. */
const PAD_SEC = 0.15;

/**
 * Gaps BETWEEN consecutive words longer than gapSec, each shrunk by the
 * padding on both sides. A gap too small to survive the padding is dropped.
 */
export function silenceCuts(words: Word[], gapSec = 0.6): CutRange[] {
  const out: CutRange[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const next = words[i];
    // The epsilon keeps float noise (1.6 - 1 = 0.6000000000000001) from
    // turning a gap exactly at the threshold into a cut.
    if (next.start - prev.end > gapSec + 1e-9) {
      const start = prev.end + PAD_SEC;
      const end = next.start - PAD_SEC;
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

/** Lowercased word with leading and trailing punctuation stripped. */
function bare(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/** Each filler word's own range. */
export function fillerCuts(words: Word[]): CutRange[] {
  return words
    .filter((w) => FILLER_WORDS.includes(bare(w.word)))
    .map((w) => ({ start: w.start, end: w.end }));
}
