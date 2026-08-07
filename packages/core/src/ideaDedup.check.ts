import assert from "node:assert/strict";
import { ideaSimilarity, ideaTokens, isDuplicateIdea, SAME_IDEA } from "./ideaDedup";

/* ---- tokens ---- */

assert.deepEqual(
  [...ideaTokens("A video comparing shop cost at 137 an hour.")].sort(),
  ["137", "comparing", "cost", "hour", "shop"],
  "noise words and punctuation are dropped, numbers are kept",
);
assert.equal(ideaTokens("").size, 0, "an empty string has no tokens");
assert.equal(ideaTokens("the and of to").size, 0, "pure noise has no tokens");

/* ---- similarity ---- */

assert.equal(ideaSimilarity("same words here", "same words here"), 1, "identical is 1");
assert.equal(ideaSimilarity("", ""), 1, "two empties are the same, not a divide by zero");
assert.equal(ideaSimilarity("something", ""), 0, "one empty side is 0");
assert.equal(
  ideaSimilarity("restoring a gearbox", "baking sourdough bread"),
  0,
  "nothing in common is 0",
);

/* ---- the case this was written for ---- */

// Both of these came out of one real pair of runs. They differ by the word
// "that", which is noise, so they are the same idea and only one belongs in
// the list.
const A = "An honest video explaining that you never do paint work in house.";
const B = "An honest video explaining you never do paint work in house.";
assert.equal(ideaSimilarity(A, B), 1, "a one word difference is still the same idea");
assert.ok(isDuplicateIdea(B, [A]), "and it is caught as a duplicate");

/* ---- what must still get through ---- */

// Same brand, same vocabulary, genuinely different videos. If the threshold
// ever catches these the operator silently stops receiving ideas.
const C = "A full car restoration filmed start to finish in the shop.";
const D = "A step by step repair anyone can follow with basic tools.";
assert.ok(
  ideaSimilarity(C, D) < SAME_IDEA,
  "two different ideas in one niche are not duplicates",
);
assert.ok(!isDuplicateIdea(D, [C, A]), "and neither is flagged against the others");

assert.ok(!isDuplicateIdea("anything at all", []), "nothing is a duplicate of an empty list");

/*
 * ponytail: lexical overlap only. This pair is the same idea to a reader and
 * scores about 0.39, so it is NOT caught here:
 *   "A video comparing shop cost at 137 an hour to doing the same job at home."
 *   "A cost comparison of the shop bay rate against doing the job at home."
 * No word threshold separates that from two genuinely distinct ideas without
 * also eating them. The prompt carries the real defence: the generator is told
 * the brand's open ideas and instructed not to write them again. Upgrade path
 * is embeddings if reworded repeats ever become a real complaint.
 */
const REWORDED_A = "A video comparing shop cost at 137 an hour to doing the same job at home.";
const REWORDED_B = "A cost comparison of the shop bay rate against doing the job at home.";
assert.ok(
  ideaSimilarity(REWORDED_A, REWORDED_B) < SAME_IDEA,
  "the documented ceiling: a full rewording is not caught lexically",
);

console.log("ideaDedup.check.ts: ok");
