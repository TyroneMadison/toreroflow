// The since-joining panel is shown to win clients, so each rule that keeps it
// honest is pinned: change needs two days, zeros and pre-join days are
// ignored, and an unreported post is never summed as zero views.
import assert from "node:assert/strict";
import { followerChange, viewTotals } from "./results";

const joined = "2026-09-01T15:00:00.000Z";

// The first count from the join day on, against the latest.
{
  const c = followerChange(
    [
      { capturedAt: "2026-08-30T04:00:00.000Z", followers: 5000 }, // before joining: ignored
      { capturedAt: "2026-09-02T04:00:00.000Z", followers: 7645 },
      { capturedAt: "2026-09-20T04:00:00.000Z", followers: null },
      { capturedAt: "2026-10-03T04:00:00.000Z", followers: 16064 },
    ],
    joined,
  );
  assert.ok(c, "two days of data is a change");
  assert.equal(c.start, 7645, "starts at the first count after joining");
  assert.equal(c.startOn, "2026-09-02");
  assert.equal(c.now, 16064);
  assert.equal(c.change, 8419);
  assert.equal(c.pct, 110.1, "rounded to one decimal");
}

// The join day itself counts, even when the snapshot came in earlier that day.
{
  const c = followerChange(
    [
      { capturedAt: "2026-09-01T04:00:00.000Z", followers: 100 },
      { capturedAt: "2026-09-05T04:00:00.000Z", followers: 90 },
    ],
    joined,
  );
  assert.equal(c?.change, -10, "a loss is reported as a loss");
}

// One day of data is a baseline, not a result.
assert.equal(
  followerChange(
    [
      { capturedAt: "2026-09-02T04:00:00.000Z", followers: 10 },
      { capturedAt: "2026-09-02T20:00:00.000Z", followers: 12 },
    ],
    joined,
  ),
  null,
  "same-day readings are not a change",
);

// A provider zero is not a launch from nothing.
assert.equal(
  followerChange(
    [
      { capturedAt: "2026-09-02T04:00:00.000Z", followers: 0 },
      { capturedAt: "2026-09-03T04:00:00.000Z", followers: 900 },
    ],
    joined,
  ),
  null,
  "zero is skipped, leaving one day",
);

// Views: unreported posts are counted as posts, never as zero views.
{
  const t = viewTotals([
    { platform: "instagram", title: "a", url: null, publishedAt: null, views: 100 },
    { platform: "instagram", title: "b", url: null, publishedAt: null, views: 5000 },
    { platform: "tiktok", title: "c", url: null, publishedAt: null, views: null },
    { platform: "youtube", title: "d", url: null, publishedAt: null, views: 0 },
  ]);
  assert.equal(t.total, 5100);
  assert.equal(t.posts, 4);
  assert.equal(t.reporting, 3, "a genuine zero reported, a null did not");
  assert.equal(t.best?.title, "b");
  assert.deepEqual(t.byPlatform.tiktok, { posts: 1, reporting: 0, views: 0 });
  assert.deepEqual(t.byPlatform.instagram, { posts: 2, reporting: 2, views: 5100 });
}

assert.equal(viewTotals([]).best, null, "no posts, no best post");

console.log("results.check: all checks passed");
