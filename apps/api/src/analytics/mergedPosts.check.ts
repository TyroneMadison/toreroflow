// Guards the merge preference. YouTube's stored rows are the platform's
// own lifetime numbers and must always win. Every other platform's stored
// rows are yesterday's copy of the same provider feed: the live post is
// fresher and carries shares and watch time the store does not, so a
// stored row that shadowed it would silently degrade the screen.
import assert from "node:assert/strict";
import { entryPlatformKey, keepStoredRow, storedWatchSec } from "./mergedPosts";

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

/* ---- a stored row keeps the watch time it was captured with ---- */

assert.equal(
  storedWatchSec(12.5, null),
  12.5,
  "the live figure wins while the post is still inside the provider window",
);
assert.equal(
  storedWatchSec(null, 9.25),
  9.25,
  "a post that has aged out of the window keeps the watch time captured when it was visible",
);
assert.equal(storedWatchSec(null, null), null, "neither source measured it, so nothing is shown");
assert.equal(storedWatchSec(0, 9.25), 9.25, "a zero live figure is not a measurement, so the store wins");

/* ---- timestamp parsing: never throw, garbage yields null ---- */

import { buildMergedPosts } from "./mergedPosts";

// Verify that buildMergedPosts uses the same parser as providerDate and handles
// zone-marked timestamps and garbage without throwing. A malformed timestamp
// must yield null, never throw RangeError from toISOString().

const mockDeps = {
  prisma: {
    client: {
      findFirst: async () => ({
        id: "client1",
        providerProfileId: null,
        socialAccounts: [{ id: "za1", platform: "instagram" as const, providerAccountId: "pa1" }],
      }),
    },
    postTarget: { findMany: async () => [] },
    externalVideo: { findMany: async () => [] },
  },
  zernio: {
    analytics: async () => [
      // Zone-marked timestamp: "2026-08-10 21:16:37+00:00" already has a zone marker.
      // The parser must not append "Z", must not throw, must parse correctly.
      {
        _id: "post1",
        content: "Zone marked",
        publishedAt: "2026-08-10T21:16:37Z",
        platforms: [{ accountId: "pa1", platformPostId: "plat1" }],
        analytics: { lastUpdated: "2026-08-10 21:16:37+00:00", views: 10 },
      },
      // Garbage timestamp: must not throw toISOString() RangeError,
      // must yield null in metricsUpdatedAt.
      {
        _id: "post2",
        content: "Garbage time",
        publishedAt: "2026-08-10T21:16:37Z",
        platforms: [{ accountId: "pa1", platformPostId: "plat2" }],
        analytics: { lastUpdated: "not-a-date", views: 20 },
      },
    ],
  },
};

const result = await buildMergedPosts(mockDeps as any, "client1", "agency1");
assert(result, "buildMergedPosts must return posts");
assert.equal(result.length, 2, "both posts should be included");

const zoneMarked = result.find((p) => p.id === "post1");
assert(zoneMarked, "zone-marked post must be found");
assert(zoneMarked.metricsUpdatedAt, "zone-marked timestamp must parse successfully");
assert(typeof zoneMarked.metricsUpdatedAt === "string", "parsed timestamp must be ISO string");

const garbage = result.find((p) => p.id === "post2");
assert(garbage, "garbage-timestamp post must be found");
assert.equal(garbage.metricsUpdatedAt, null, "garbage timestamp must yield null, not throw");

console.log("mergedPosts.check: all checks passed");
