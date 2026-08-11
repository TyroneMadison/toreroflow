import type { ClientPost } from "./api";
import { buildTier, scopeToPlatform, TIER_BOUNDS } from "./viewTiers";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  },
};

/**
 * Runnable check for the view-tier boards: `pnpm --filter @toreroflow/desktop test`.
 *
 * The bug this exists to prevent: the boards were derived from a list the
 * range selector had already filtered, so on the default thirty day window a
 * catalogue holding six million-view videos reported an empty 1M+ club. The
 * first case below fails if that wiring ever returns.
 */

const DAY = 86_400_000;
const now = Date.UTC(2026, 6, 26);

const post = (
  id: string,
  views: number,
  daysAgo: number,
  platforms: ClientPost["platforms"] = ["youtube"],
): ClientPost => ({
  id,
  mediaType: "video",
  title: `video ${id}`,
  publishedAt: new Date(now - daysAgo * DAY).toISOString(),
  thumbnailUrl: null,
  url: null,
  platforms,
  views,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  reach: 0,
  follows: 0,
  impressions: null,
  clicks: null,
  totalWatchSec: null,
  avgWatchSec: null,
  durationSec: null,
  byPlatform: platforms.map((p) => ({ platform: p, views })),
});

/* A catalogue shaped like a real one: the big hits are old. */
const catalogue: ClientPost[] = [
  post("a", 13_465_743, 296),
  post("b", 7_039_241, 257),
  post("c", 4_556_269, 285),
  post("d", 250_000, 200),
  post("e", 120_000, 5),
  post("f", 40_000, 10),
  post("g", 900, 2),
];

const cutoff30 = now - 30 * DAY;

/* The regression: a lifetime board must not be emptied by the range. */
{
  const tier = buildTier(catalogue, 1_000_000, null, cutoff30);
  assert.equal(tier.total, 3, "1M+ board must rank all time, not the selected range");
  assert.equal(tier.posts[0]!.views, 13_465_743, "highest viewed video ranks first");
  assert.equal(tier.addedInRange, 0, "none of the million-view videos are recent");
}

/* Momentum still reflects the range. */
{
  const tier = buildTier(catalogue, 100_000, 1_000_000, cutoff30);
  assert.equal(tier.total, 2, "250K and 120K both sit in the 100K band");
  assert.equal(tier.addedInRange, 1, "only the 120K video landed inside thirty days");
}

/* Bounds do not overlap: every post lands in at most one tier. */
{
  const counted = TIER_BOUNDS.map((b) => buildTier(catalogue, b.min, b.max, 0).total);
  assert.deepEqual(counted, [3, 2, 1], "tiers partition the catalogue");
  assert.equal(
    counted.reduce((a, b) => a + b, 0),
    catalogue.filter((p) => p.views >= 10_000).length,
    "no post is double counted across tiers",
  );
}

/* Platform scoping ranks a cross-post on that platform's views alone. */
{
  const cross: ClientPost = {
    ...post("x", 0, 1, ["youtube", "instagram"]),
    byPlatform: [
      { platform: "youtube", views: 1_200_000 },
      { platform: "instagram", views: 4_000 },
    ],
  };
  const yt = scopeToPlatform([cross], "youtube");
  assert.equal(yt[0]!.views, 1_200_000, "YouTube tab ranks on YouTube views");
  const ig = scopeToPlatform([cross], "instagram");
  assert.equal(ig[0]!.views, 4_000, "Instagram tab ranks on Instagram views");
  assert.equal(
    buildTier(ig, 1_000_000, null, 0).total,
    0,
    "a video only in the club on YouTube is not in it on Instagram",
  );
}

/* Two accounts on one platform are two tabs with two sets of numbers. */
{
  const pageA: ClientPost = {
    ...post("a", 0, 1, ["facebook"]),
    byPlatform: [{ platform: "facebook", views: 9_000, accountId: "acc-a" }],
  };
  const pageB: ClientPost = {
    ...post("b", 0, 1, ["facebook"]),
    byPlatform: [{ platform: "facebook", views: 500, accountId: "acc-b" }],
  };
  // An older cached post that never learned which page it belongs to.
  const orphan: ClientPost = {
    ...post("o", 0, 1, ["facebook"]),
    byPlatform: [{ platform: "facebook", views: 70 }],
  };
  const all = [pageA, pageB, orphan];
  assert.equal(
    scopeToPlatform(all, "facebook").length,
    3,
    "the platform-wide scope still sees every Facebook post",
  );
  const a = scopeToPlatform(all, "facebook", "acc-a");
  assert.equal(a.length, 1, "an account tab sees only its own posts");
  assert.equal(a[0]!.views, 9_000, "and ranks on that account's views");
  assert.equal(
    scopeToPlatform(all, "facebook", "acc-b")[0]!.views,
    500,
    "the second page is its own set of numbers, not a copy of the first",
  );
  assert.equal(
    scopeToPlatform(all, "facebook", "acc-a").some((p) => p.id === "o"),
    false,
    "a post that cannot prove its account stays off account tabs",
  );
}

/* An all-time selection counts everything as in range. */
{
  const tier = buildTier(catalogue, 1_000_000, null, 0);
  assert.equal(tier.addedInRange, 3, "cutoff 0 means every post counts as in range");
}

console.log("viewTiers: all checks passed");
