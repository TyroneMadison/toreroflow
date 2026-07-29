import assert from "node:assert/strict";
import { hasMachineTells, toPlainText } from "./plainText";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * These strings are real output from the suggestions model, which is why
 * they are the cases pinned here. The document goes to a paying client
 * under Tyrone's name, so "the prompt asks it not to" is not the control.
 */

// Em dash joining two clauses becomes the comma a person would have used.
assert.equal(
  toPlainText("Facebook has 2765 views — 20x lower than the other accounts."),
  "Facebook has 2765 views, 20x lower than the other accounts.",
);

// Unspaced em dash was standing in for a join, so a hyphen fits.
assert.equal(toPlainText("high—retention edits"), "high-retention edits");

// En dashes go the same way, spaced or not.
assert.equal(toPlainText("clips 12–18s"), "clips 12-18s");
assert.equal(toPlainText("post daily – it compounds"), "post daily, it compounds");

// Arrows, unicode and the ASCII ones people type.
assert.equal(toPlainText("hook→proof→payoff"), "hook to proof to payoff");
assert.equal(toPlainText("TikTok → Reels"), "TikTok to Reels");
assert.equal(toPlainText("draft -> post"), "draft to post");
assert.equal(toPlainText("idea => script"), "idea to script");

// Smart punctuation.
assert.equal(toPlainText("Northstar’s audience"), "Northstar's audience");
assert.equal(toPlainText("“hook” first"), '"hook" first');
assert.equal(toPlainText("wait for it…"), "wait for it...");

// A clean sentence is returned untouched, minus surrounding space.
assert.equal(toPlainText("  Post one video a day.  "), "Post one video a day.");

// A hyphen that was always a hyphen stays one.
assert.equal(toPlainText("cross-platform"), "cross-platform");

// Minus signs inside real text are left alone: only arrow shapes go.
assert.equal(toPlainText("views went up 20-30%"), "views went up 20-30%");

// The comma substitution must not leave doubled punctuation behind.
assert.equal(toPlainText("Do this, — and then that"), "Do this, and then that");

// Detector agrees with the cleaner: anything it flags, cleaning removes.
const dirty = [
  "views — down",
  "a – b",
  "hook→proof",
  "a -> b",
  "a => b",
  "it’s",
  "“quoted”",
  "wait…",
];
for (const s of dirty) {
  assert.equal(hasMachineTells(s), true, `should be flagged: ${s}`);
  assert.equal(hasMachineTells(toPlainText(s)), false, `should be clean after: ${s}`);
}

const clean = ["Post one video a day.", "cross-platform", "12-18 seconds", "20-30%"];
for (const s of clean) {
  assert.equal(hasMachineTells(s), false, `should not be flagged: ${s}`);
  assert.equal(toPlainText(s), s, `should be unchanged: ${s}`);
}

console.log("plainText: all checks passed");
