import { annotateWords, pauseGaps, peaksFromPcm, stitchWindows, transcribeWindows } from "./words";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}
function deepEq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}
const mk = (texts: string[]) => texts.map((word, i) => ({ start: i, end: i + 0.5, word }));

// Fillers: single words and whole phrases, length and order unchanged.
const a = annotateWords(mk(["Um,", "you", "know", "it's", "kind", "good", "kind", "of."]));
deepEq(
  a.map((w) => w.kind),
  ["filler", "filler", "filler", "word", "word", "word", "filler", "filler"],
  "single and multi-word fillers flagged, a lone 'kind' is not",
);
eq(a.length, 8, "no tokens inserted");

// Pauses: 0.5 s gaps between mk words, threshold 0.3 catches all, 0.6 none.
eq(pauseGaps(mk(["a", "b", "c"])).length, 2, "two pauses at 0.3 s");
eq(pauseGaps(mk(["a", "b", "c"]), 0.6).length, 0, "none at 0.6 s");
deepEq(pauseGaps(mk(["a", "b"]))[0], { after: 0, start: 0.5, end: 1 }, "pause bounds");

// Windows: short sources stay one request, a 60 min talk is 7 windows.
deepEq(transcribeWindows(300), [{ start: 0, dur: 300 }], "short source is one window");
const win = transcribeWindows(3600);
eq(win.length, 7, "60 min splits into 7 overlapping windows");
eq(win[1].start, 598, "second window starts 2 s before the first ends");
eq(win[win.length - 1].start + win[win.length - 1].dur, 3600, "last window reaches the end");

// Stitch: a word heard in both windows' overlap is kept once.
const w0 = { start: 0, dur: 10 };
const w1 = { start: 8, dur: 10 };
const stitched = stitchWindows([
  { window: w0, words: [{ start: 1, end: 2, word: "a" }, { start: 8.5, end: 8.8, word: "b" }, { start: 9.5, end: 9.9, word: "c" }] },
  { window: w1, words: [{ start: 8.5, end: 8.8, word: "b" }, { start: 9.5, end: 9.9, word: "c" }, { start: 12, end: 13, word: "d" }] },
]);
deepEq(stitched.map((w) => w.word), ["a", "b", "c", "d"], "overlap deduped at the midpoint");

// Peaks: loudest per bucket, 0..100.
const pcm = new Int16Array([0, 16384, -32768, 100]);
deepEq(peaksFromPcm(pcm, 4, 2), [50, 100], "two buckets of two samples");

console.log("words.check: all checks passed");
