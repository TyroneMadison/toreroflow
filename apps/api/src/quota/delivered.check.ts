// Which counter an upload lands on: trial reels are their own work, never short-form.
import assert from "node:assert/strict";
import { isTrialTarget, quotaBucket } from "./delivered";

const trial = { platform: "instagram", options: { instagram: { trial: true, graduationStrategy: "MANUAL" } } };
const reel = { platform: "instagram", options: {} };
const tiktok = { platform: "tiktok", options: null };
const story = { platform: "instagram", options: { instagram: { trial: true, story: true } } };
const video = (format: string | null, targets: Array<{ platform: string; options: unknown }>, fromDrive = false) =>
  quotaBucket({ kind: "video", format, targets, fromDrive });

assert.equal(isTrialTarget(trial), true);
assert.equal(isTrialTarget(story), false, "a story is never a trial reel");
assert.equal(isTrialTarget(reel), false);
assert.equal(
  isTrialTarget({ platform: "instagram", options: { instagram: { trial: true }, instagramFeedPost: true } }),
  false,
  "a trial retried as a plain reel went to every follower, so it is not a trial reel",
);

assert.equal(video("short_form", [trial]), "trial", "only ever a trial reel");
assert.equal(video("short_form", [trial, trial]), "trial", "a trial reel on two accounts is still one trial reel");
assert.equal(video("short_form", [trial, tiktok]), "short", "also on TikTok: short-form work");
assert.equal(video("short_form", [trial, reel]), "short", "also a normal reel: short-form work");
assert.equal(video("short_form", [trial, story]), "trial", "the story copy of a trial reel does not make it a short");
assert.equal(video("short_form", [story]), "short", "a story alone is not a trial reel");
assert.equal(video("long_form", [trial]), "trial", "the trial decides, not the length");
assert.equal(video("short_form", []), "short", "not scheduled yet: counted by format, as before");
assert.equal(video("long_form", [tiktok]), "long");
assert.equal(video(null, []), "unclassified", "still being probed");
assert.equal(video("short_form", [], true), null, "a Drive video not on the calendar yet is not delivered work");
assert.equal(video("short_form", [trial], true), "trial", "a Drive video once scheduled is a trial reel");
assert.equal(video("short_form", [tiktok], true), "short", "a Drive video scheduled by hand elsewhere is short-form");
assert.equal(quotaBucket({ kind: "carousel", format: null, targets: [trial], fromDrive: false }), "carousel");
assert.equal(quotaBucket({ kind: "image", format: null, targets: [], fromDrive: false }), null);

console.log("quota/delivered.check: ok");
