import { FILLER_WORDS, fillerCuts, silenceCuts } from "./autoCut";

/** Local assert so the file typechecks with the app and needs no node types. */
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

function deepEq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

/** Round to 3dp so float padding math compares exactly. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function r3Cuts(cuts: { start: number; end: number }[]) {
  return cuts.map((c) => ({ start: r3(c.start), end: r3(c.end) }));
}

// The filler list is pinned.
deepEq(FILLER_WORDS, ["um", "uh", "er", "uhm", "erm"], "filler word list");

// Silence: a 1.0s gap shrinks by 0.15s padding on both sides.
const w = (start: number, end: number, word: string) => ({ start, end, word });
deepEq(
  r3Cuts(silenceCuts([w(0, 1, "a"), w(2, 2.5, "b"), w(2.55, 3, "c")])),
  [{ start: 1.15, end: 1.85 }],
  "1.0s gap becomes a padded cut, 0.05s gap does not",
);

// A gap exactly at the threshold is not a cut, strictly longer only.
deepEq(silenceCuts([w(0, 1, "a"), w(1.6, 2, "b")]), [], "gap equal to gapSec is kept");

// Custom gapSec: a gap the padding would invert is dropped entirely.
deepEq(silenceCuts([w(0, 1, "a"), w(1.25, 2, "b")], 0.2), [], "gap smaller than the padding is dropped");
deepEq(
  r3Cuts(silenceCuts([w(0, 1, "a"), w(1.4, 2, "b")], 0.2)),
  [{ start: 1.15, end: 1.25 }],
  "custom gapSec still pads both sides",
);

// No words, one word: no gaps exist.
deepEq(silenceCuts([]), [], "no words, no cuts");
deepEq(silenceCuts([w(0, 5, "a")]), [], "one word, no cuts");

// Fillers match lowercased with leading and trailing punctuation stripped.
const filler = fillerCuts([
  w(0, 0.2, "Um,"),
  w(0.2, 0.5, "hello"),
  w(0.5, 0.7, "uh"),
  w(0.7, 1.1, "drummer"),
  w(1.1, 1.3, "ERM."),
  w(1.3, 1.6, "her"),
  w(1.6, 1.8, "...er"),
]);
deepEq(
  filler,
  [
    { start: 0, end: 0.2 },
    { start: 0.5, end: 0.7 },
    { start: 1.1, end: 1.3 },
    { start: 1.6, end: 1.8 },
  ],
  "Um, uh, ERM. and ...er match, drummer and her do not",
);
eq(fillerCuts([]).length, 0, "no words, no filler cuts");

console.log("autoCut.check: all assertions passed");
