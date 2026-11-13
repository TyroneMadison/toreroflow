/**
 * Transcript plumbing for long sources: filler flags, pause gaps, windowed
 * transcription stitching, and waveform peaks. Pure, so the worker and the
 * checks agree on one exact answer.
 */

import type { Word } from "./autoCut";

/**
 * Single-word fillers. The multi-word list below is matched as a phrase, so
 * "kind of" is a filler while "kind" alone never is.
 */
export const FILLER_SINGLE: string[] = ["um", "uh", "er", "uhm", "erm", "hmm", "mm"];
export const FILLER_PHRASES: string[][] = [
  ["you", "know"],
  ["i", "mean"],
  ["kind", "of"],
  ["sort", "of"],
];

function bare(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

/**
 * Marks fillers in place of nothing: returns a new list, same length, same
 * order, with kind "filler" on single fillers and on every word of a filler
 * phrase, and kind "word" on the rest.
 *
 * ponytail: silence is not inserted as tokens. Word indices key wordEdits,
 * captions and the word editor, and an extra token per gap would shift every
 * index the existing desktop reads. Pauses come from pauseGaps instead,
 * computed from the same word times; upgrade path is EditDoc v2 readers that
 * skip kind "silence".
 */
export function annotateWords(words: Word[], single = FILLER_SINGLE, phrases = FILLER_PHRASES): Word[] {
  const kinds: ("word" | "filler")[] = words.map((w) => (single.includes(bare(w.word)) ? "filler" : "word"));
  const b = words.map((w) => bare(w.word));
  for (let i = 0; i < words.length; i++) {
    for (const p of phrases) {
      if (i + p.length > words.length) continue;
      let hit = true;
      for (let k = 0; k < p.length; k++) {
        if (b[i + k] !== p[k]) {
          hit = false;
          break;
        }
      }
      if (hit) for (let k = 0; k < p.length; k++) kinds[i + k] = "filler";
    }
  }
  return words.map((w, i) => ({ ...w, kind: kinds[i] }));
}

export interface PauseGap {
  /** Index of the word the pause follows. */
  after: number;
  start: number;
  end: number;
}

/** Gaps between consecutive words of at least minSec (default 0.3 s). */
export function pauseGaps(words: Word[], minSec = 0.3): PauseGap[] {
  const out: PauseGap[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minSec - 1e-9) out.push({ after: i - 1, start: words[i - 1].end, end: words[i].start });
  }
  return out;
}

export interface TranscribeWindow {
  start: number;
  dur: number;
}

/** Sources at or under this length go to the captions service in one request. */
export const WINDOW_THRESHOLD_SEC = 20 * 60;

/**
 * Window plan for a long source: 10 min windows overlapping by 2 s. Under the
 * threshold the whole file is one window, so short clips behave as before.
 */
export function transcribeWindows(durationSec: number, windowSec = 600, overlapSec = 2): TranscribeWindow[] {
  if (!(durationSec > WINDOW_THRESHOLD_SEC)) return [{ start: 0, dur: Math.max(0, durationSec) }];
  const out: TranscribeWindow[] = [];
  for (let s = 0; s < durationSec; s += windowSec - overlapSec) {
    out.push({ start: s, dur: Math.min(windowSec, durationSec - s) });
    if (s + windowSec >= durationSec) break;
  }
  return out;
}

/**
 * Stitches per-window words (already shifted to source time) into one list.
 * Each overlap is split at its midpoint: the earlier window owns words that
 * start before it, the later window owns the rest, so a word heard twice in
 * the overlap is kept once.
 */
export function stitchWindows(parts: { window: TranscribeWindow; words: Word[] }[]): Word[] {
  const out: Word[] = [];
  parts.forEach((p, i) => {
    const prev = parts[i - 1];
    const next = parts[i + 1];
    const lo = prev ? (p.window.start + prev.window.start + prev.window.dur) / 2 : -Infinity;
    const hi = next ? (next.window.start + p.window.start + p.window.dur) / 2 : Infinity;
    for (const w of p.words) if (w.start >= lo && w.start < hi) out.push(w);
  });
  return out;
}

/**
 * Waveform peaks from mono 16-bit PCM: the loudest absolute sample per bucket,
 * scaled 0..100. perSec buckets per second of audio.
 */
export function peaksFromPcm(samples: Int16Array, sampleRate: number, perSec = 50): number[] {
  const size = Math.max(1, Math.round(sampleRate / perSec));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += size) {
    let m = 0;
    const end = Math.min(samples.length, i + size);
    for (let k = i; k < end; k++) {
      const v = Math.abs(samples[k]);
      if (v > m) m = v;
    }
    out.push(Math.round((m / 32768) * 100));
  }
  return out;
}
