// Guards the merge preference. YouTube's stored rows are the platform's
// own lifetime numbers and must always win. Every other platform's stored
// rows are yesterday's copy of the same provider feed: the live post is
// fresher and carries shares and watch time the store does not, so a
// stored row that shadowed it would silently degrade the screen.
import assert from "node:assert/strict";
import { entryPlatformKey, keepStoredRow } from "./mergedPosts";

assert.equal(keepStoredRow("youtube", true), true);
assert.equal(keepStoredRow("youtube", false), true);
assert.equal(keepStoredRow("instagram", true), false);
assert.equal(keepStoredRow("instagram", false), true);
assert.equal(keepStoredRow("tiktok", true), false);
assert.equal(keepStoredRow("facebook", false), true);

// entryPlatformKey: known accountId maps to its platform through the account
// lookup, an unknown accountId falls back to the entry's own platform field,
// and a missing platformPostId has nothing to key on.
assert.equal(
  entryPlatformKey({ accountId: "za1", platformPostId: "p1" }, new Map([["za1", "instagram"]])),
  "instagram:p1",
);
assert.equal(
  entryPlatformKey({ accountId: "za9", platform: "tiktok", platformPostId: "p2" }, new Map()),
  "tiktok:p2",
);
assert.equal(entryPlatformKey({ accountId: "za1" }, new Map([["za1", "instagram"]])), null);

console.log("mergedPosts.check: all checks passed");
