/**
 * Caption chunking, transcript words to sentences and timed caption chunks.
 * Pure, side-effect-free.
 */

import type { Word } from "./autoCut";

export interface SentenceWord extends Word {
  index: number;
}

export interface Sentence {
  start: number;
  end: number;
  words: SentenceWord[];
}

/**
 * Splits on . ! ? terminators, the terminator word stays with its sentence.
 * Trailing non-terminated words form a final sentence. Never emits an empty
 * sentence. index is the word's position in the input list.
 */
export function sentencesFromWords(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let current: SentenceWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    out.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
  };
  words.forEach((w, index) => {
    current.push({ ...w, index });
    if (/[.!?]$/.test(w.word)) flush();
  });
  flush();
  return out;
}

/**
 * Word text replacements applied by index into the input list. Times keep,
 * the input is never mutated.
 */
export function editedWords(words: Word[], edits: Record<number, string>): Word[] {
  return words.map((w, i) => (edits[i] === undefined ? w : { ...w, word: edits[i] }));
}

export interface CaptionChunk {
  start: number;
  end: number;
  text: string;
  /**
   * Each word's own start/end, in chunk order. Only chunksWithTimes sets it;
   * the ASS writer uses it for word-timed karaoke and falls back to an even
   * split when it is missing or the word count no longer matches (a manual
   * break override rewrote the text).
   */
  times?: { start: number; end: number }[];
}

/**
 * Greedy packing, wordsPerLine * lines words per chunk. Chunk start is the
 * first word's start, end the last word's end. Words join with single spaces,
 * lines break at wordsPerLine boundaries with \n in text.
 */
export function chunksFor(
  words: Word[],
  wordsPerLine: 1 | 2 | 3 | 4 | 5,
  lines: 1 | 2,
): CaptionChunk[] {
  const perChunk = wordsPerLine * lines;
  const out: CaptionChunk[] = [];
  for (let i = 0; i < words.length; i += perChunk) {
    const group = words.slice(i, i + perChunk);
    const lineTexts: string[] = [];
    for (let j = 0; j < group.length; j += wordsPerLine) {
      lineTexts.push(
        group
          .slice(j, j + wordsPerLine)
          .map((w) => w.word)
          .join(" "),
      );
    }
    out.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      text: lineTexts.join("\n"),
    });
  }
  return out;
}

/** chunksFor plus per-word times, for the render path. */
export function chunksWithTimes(
  words: Word[],
  wordsPerLine: 1 | 2 | 3 | 4 | 5,
  lines: 1 | 2,
): CaptionChunk[] {
  const perChunk = wordsPerLine * lines;
  return chunksFor(words, wordsPerLine, lines).map((c, k) => ({
    ...c,
    times: words.slice(k * perChunk, (k + 1) * perChunk).map((w) => ({ start: w.start, end: w.end })),
  }));
}
