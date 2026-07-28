// Guards the watch-next append: the link lands exactly once, at the end,
// and an empty description must not produce leading blank lines.
import assert from "node:assert/strict";
import { appendWatchNext } from "./text";

assert.equal(
  appendWatchNext("Big turbo day.", "https://www.youtube.com/watch?v=abc"),
  "Big turbo day.\n\nWatch next: https://www.youtube.com/watch?v=abc",
);
assert.equal(
  appendWatchNext("", "https://www.youtube.com/watch?v=abc"),
  "Watch next: https://www.youtube.com/watch?v=abc",
);
assert.equal(appendWatchNext("Big turbo day.", undefined), "Big turbo day.");
assert.equal(appendWatchNext("", undefined), "");

console.log("text helpers: all checks passed");
