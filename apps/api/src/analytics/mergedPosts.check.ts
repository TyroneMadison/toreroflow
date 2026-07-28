// Guards the merge preference. YouTube's stored rows are the platform's
// own lifetime numbers and must always win. Every other platform's stored
// rows are yesterday's copy of the same provider feed: the live post is
// fresher and carries shares and watch time the store does not, so a
// stored row that shadowed it would silently degrade the screen.
import assert from "node:assert/strict";
import { keepStoredRow } from "./mergedPosts";

assert.equal(keepStoredRow("youtube", true), true);
assert.equal(keepStoredRow("youtube", false), true);
assert.equal(keepStoredRow("instagram", true), false);
assert.equal(keepStoredRow("instagram", false), true);
assert.equal(keepStoredRow("tiktok", true), false);
assert.equal(keepStoredRow("facebook", false), true);

console.log("mergedPosts.check: all checks passed");
