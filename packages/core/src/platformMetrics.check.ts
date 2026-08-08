import assert from "node:assert/strict";
import {
  followsMeasurable,
  reportsSaves,
  SAVES_REPORTED_BY,
  savesMeasurable,
} from "./platformMetrics";

/* ---- the platform list ---- */

assert.ok(SAVES_REPORTED_BY.has("instagram"), "instagram reports saves");
assert.ok(
  !SAVES_REPORTED_BY.has("tiktok"),
  "tiktok has a save button but has never reported the number, see the note in platformMetrics.ts",
);
assert.ok(!SAVES_REPORTED_BY.has("youtube"), "youtube has no save button");
assert.ok(!SAVES_REPORTED_BY.has("facebook"), "facebook has no save button");

/* ---- per post ---- */

assert.ok(reportsSaves(["instagram"]), "an instagram post reports saves");
assert.ok(!reportsSaves(["tiktok"]), "a tiktok post does not");
assert.ok(!reportsSaves([]), "a post on nothing reports nothing");
// Cross-posts are the common case here: one upload fanned out to several
// platforms. One save-reporting platform in the list is enough for the number
// on that post to mean something.
assert.ok(reportsSaves(["tiktok", "instagram"]), "a cross-post including instagram does");
assert.ok(!reportsSaves(["tiktok", "youtube"]), "a cross-post with neither does not");

/* ---- across a set ---- */

const IG = { platforms: ["instagram"], follows: 0 };
const TT = { platforms: ["tiktok"], follows: 0 };
const YT = { platforms: ["youtube"], follows: 0 };

assert.ok(savesMeasurable([TT, IG, YT]), "a mixed period has measurable saves");
assert.ok(!savesMeasurable([TT, YT]), "a tiktok and youtube period does not");
assert.ok(!savesMeasurable([]), "an empty period does not");

/* ---- follows, asked of the data rather than declared ---- */

assert.ok(!followsMeasurable([IG, TT, YT]), "all zero means nobody measured it");
assert.ok(!followsMeasurable([]), "an empty period measures nothing");
assert.ok(
  followsMeasurable([IG, { platforms: ["instagram"], follows: 4 }]),
  "one real number anywhere is enough to start showing it",
);

/*
 * The whole point of this module: the screen and the report have to answer
 * these the same way. Both now call the functions above, so this asserts the
 * property they used to violate by keeping their own copies of the list.
 */
const period = [TT, TT, YT];
assert.equal(
  savesMeasurable(period),
  false,
  "a tiktok-only period is unmeasurable, so the screen dashes it and the report omits the row",
);

console.log("platformMetrics.check.ts: ok");
