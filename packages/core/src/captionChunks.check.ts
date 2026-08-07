import { chunksFor, editedWords, sentencesFromWords } from "./captionChunks";

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

/** Word n runs from n to n + 0.5. */
function mk(texts: string[]) {
  return texts.map((word, i) => ({ start: i, end: i + 0.5, word }));
}

// Sentences split on . ! ? with the terminator word attached, trailing
// non-terminated words form a final sentence.
const sentences = sentencesFromWords(mk(["Hello", "world.", "How", "are", "you?", "fine"]));
eq(sentences.length, 3, "three sentences");
deepEq(
  sentences[0],
  {
    start: 0,
    end: 1.5,
    words: [
      { start: 0, end: 0.5, word: "Hello", index: 0 },
      { start: 1, end: 1.5, word: "world.", index: 1 },
    ],
  },
  "first sentence keeps its terminator word and indexes",
);
deepEq(
  sentences[1].words.map((w) => w.index),
  [2, 3, 4],
  "second sentence covers How are you?",
);
deepEq(
  sentences[2],
  { start: 5, end: 5.5, words: [{ start: 5, end: 5.5, word: "fine", index: 5 }] },
  "trailing words form a final sentence",
);
eq(sentencesFromWords(mk(["Wow!", "Yes."])).length, 2, "! and . both terminate");
deepEq(sentencesFromWords([]), [], "no words, no sentences");

// chunksFor, wordsPerLine 1 with lines 2: two words per chunk, one per line.
deepEq(
  chunksFor(mk(["a", "b", "c"]), 1, 2),
  [
    { start: 0, end: 1.5, text: "a\nb" },
    { start: 2, end: 2.5, text: "c" },
  ],
  "1 word per line, 2 lines packs pairs with a newline",
);

// wordsPerLine 3 with lines 2: six words per chunk, newline after three.
deepEq(
  chunksFor(mk(["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"]), 3, 2),
  [
    { start: 0, end: 5.5, text: "w0 w1 w2\nw3 w4 w5" },
    { start: 6, end: 7.5, text: "w6 w7" },
  ],
  "3 words per line, 2 lines packs six, remainder forms a short chunk",
);

// Single line never contains a newline.
deepEq(
  chunksFor(mk(["a", "b", "c"]), 2, 1),
  [
    { start: 0, end: 1.5, text: "a b" },
    { start: 2, end: 2.5, text: "c" },
  ],
  "1 line chunks have no newline",
);
deepEq(chunksFor([], 3, 2), [], "no words, no chunks");

// editedWords: replacements by index, times kept, input untouched.
const orig = mk(["a", "b", "c"]);
deepEq(
  editedWords(orig, { 1: "B" }),
  [
    { start: 0, end: 0.5, word: "a" },
    { start: 1, end: 1.5, word: "B" },
    { start: 2, end: 2.5, word: "c" },
  ],
  "editedWords swaps text by index and keeps times",
);
eq(orig[1].word, "b", "editedWords never mutates its input");
deepEq(editedWords(orig, {}), orig, "no edits returns the same shape");

console.log("captionChunks.check: all assertions passed");
