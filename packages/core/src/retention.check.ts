import assert from "node:assert/strict";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_THUMB_RETENTION_DAYS,
  sourceRetention,
  type RetentionTarget,
} from "./retention";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * This decides whether to delete an operator's original video, so what is
 * pinned here is every way that could go wrong: deleting one a platform still
 * needs, starting the clock from the wrong platform, or deleting the moment a
 * post goes live and losing the window to reschedule.
 */

const NOW = new Date("2026-08-20T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const posted = (whenDaysAgo: number): RetentionTarget => ({
  status: "posted",
  publishedAt: day(whenDaysAgo),
});

/* ---- the happy path ---- */

const old = sourceRetention([posted(8), posted(8)], NOW);
assert.equal(old.deletable, true, "everything posted over a week ago can go");
if (old.deletable) assert.equal(old.since.getTime(), day(8).getTime());

assert.equal(
  sourceRetention([posted(7)], NOW).deletable,
  true,
  "exactly the retention window is due",
);

/* ---- the window is the whole point ---- */

const fresh = sourceRetention([posted(1)], NOW);
assert.equal(fresh.deletable, false, "a video posted yesterday keeps its source");
if (!fresh.deletable) assert.match(fresh.reason, /6 day\(s\) short/);

/* ---- one platform is not all of them ---- */

const partly = sourceRetention([posted(30), { status: "failed", publishedAt: null }], NOW);
assert.equal(
  partly.deletable,
  false,
  "a failure on one platform keeps the file a retry would need, however old the rest is",
);
if (!partly.deletable) assert.match(partly.reason, /failed/);

assert.equal(
  sourceRetention([posted(30), { status: "scheduled", publishedAt: null }], NOW).deletable,
  false,
  "a platform still waiting keeps the source",
);
assert.equal(
  sourceRetention([posted(30), { status: "publishing", publishedAt: null }], NOW).deletable,
  false,
  "a platform mid-publish keeps the source",
);

/* ---- the clock starts at the last platform, not the first ---- */

const staggered = sourceRetention([posted(30), posted(2)], NOW);
assert.equal(
  staggered.deletable,
  false,
  "a post finished two days ago is two days old, even if it started a month ago",
);

/* ---- things that must never delete ---- */

assert.equal(
  sourceRetention([], NOW).deletable,
  false,
  "a draft nobody scheduled is work in progress, not rubbish",
);
assert.equal(
  sourceRetention([{ status: "posted", publishedAt: null }], NOW).deletable,
  false,
  "posted with no timestamp waits for a human rather than being treated as ancient",
);

/* ---- the window is configurable ---- */

assert.equal(sourceRetention([posted(3)], NOW, 2).deletable, true, "a shorter window is honoured");
assert.equal(sourceRetention([posted(20)], NOW, 30).deletable, false, "so is a longer one");
assert.equal(DEFAULT_RETENTION_DAYS, 7);

/*
 * The image window.
 *
 * Longer than the source window, and the gap matters rather than the exact
 * number: the source is what fills a disk and the images are what every card
 * draws, so the cheap thing is kept far longer than the expensive one.
 */
assert.equal(DEFAULT_THUMB_RETENTION_DAYS, 30);
assert.ok(
  DEFAULT_THUMB_RETENTION_DAYS > DEFAULT_RETENTION_DAYS,
  "images must outlive the source they came from, or a card loses its picture while the post is still recent",
);

/*
 * Both windows read the same verdict, so a post that is not finished keeps
 * everything. A video still publishing to one platform is not a candidate for
 * either sweep, however old the others are.
 */
{
  const mixed: RetentionTarget[] = [
    { status: "posted", publishedAt: new Date("2026-01-01T00:00:00Z") },
    { status: "failed", publishedAt: null },
  ];
  const long = sourceRetention(mixed, new Date("2026-06-01T00:00:00Z"), DEFAULT_THUMB_RETENTION_DAYS);
  assert.equal(long.deletable, false, "a failed platform keeps the images too, not just the source");
}

/*
 * The ordering that makes the whole scheme safe: at any moment between the two
 * windows the source is gone and the image is still there. That is the state
 * every card older than a week but younger than a month lives in.
 */
{
  const posted: RetentionTarget[] = [
    { status: "posted", publishedAt: new Date("2026-01-01T00:00:00Z") },
  ];
  const twoWeeksLater = new Date("2026-01-15T00:00:00Z");
  assert.equal(
    sourceRetention(posted, twoWeeksLater, DEFAULT_RETENTION_DAYS).deletable,
    true,
    "the source is gone at two weeks",
  );
  assert.equal(
    sourceRetention(posted, twoWeeksLater, DEFAULT_THUMB_RETENTION_DAYS).deletable,
    false,
    "and the image is still there, which is what keeps the card drawable",
  );

  const twoMonthsLater = new Date("2026-03-01T00:00:00Z");
  assert.equal(
    sourceRetention(posted, twoMonthsLater, DEFAULT_THUMB_RETENTION_DAYS).deletable,
    true,
    "the image goes once its own window has passed",
  );
}

console.log("retention.check.ts: ok");
