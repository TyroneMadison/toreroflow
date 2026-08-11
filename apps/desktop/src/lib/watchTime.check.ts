import { watchHours } from "./watchTime";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
};

const IG = {
  platforms: ["instagram"],
  views: 400,
  avgWatchSec: 5,
  totalWatchSec: 1800,
};
const TT = { platforms: ["tiktok"], views: 10000, avgWatchSec: null, totalWatchSec: null };

/*
 * The measured total wins. The screen used to compute views x avgWatchSec,
 * which is an estimate, while igReelsVideoViewTotalTime arrived on 274 of 279
 * Instagram posts and was discarded.
 */
assert.equal(watchHours([IG]), 0.5, "1800 measured seconds is half an hour");

/*
 * The bug this fixes. TikTok reports no watch time at all, and the old code
 * substituted the account-wide average, so 10,000 TikTok views inherited an
 * Instagram average and invented hours nobody measured.
 */
assert.equal(watchHours([TT]), null, "a platform that measures nothing contributes nothing");
assert.equal(
  watchHours([IG, TT]),
  0.5,
  "a mixed period counts only the posts whose platform measured it",
);

// Falls back to the estimate only when the post reports its own average.
assert.equal(
  watchHours([{ platforms: ["instagram"], views: 720, avgWatchSec: 10, totalWatchSec: null }]),
  2,
  "720 views x 10s is 7200 seconds, two hours",
);
assert.equal(watchHours([]), null, "an empty period measures nothing");

console.log("watchTime.check.ts: ok");
