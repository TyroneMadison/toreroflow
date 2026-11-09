import assert from "node:assert/strict";
import { DriveError } from "@toreroflow/publishers";
import { readDriveSource } from "@toreroflow/core";
import { downloadRetries, driveTargets, settingsMoved, transcriptionRetries, trialReelPlan } from "./drive";

/**
 * Runnable check: `pnpm --filter @toreroflow/worker test`.
 *
 * What a Drive video posts with is the whole safety story of the feature: a
 * trial reel, with the graduation the operator picked, and nothing that lets
 * it reach every follower instead.
 */

/* ---- the target options and the payload they build ---- */

for (const graduation of ["MANUAL", "SS_PERFORMANCE"] as const) {
  const plan = trialReelPlan({ graduation, format: "short_form", durationSec: 42, caption: "Words\n\n#tag" });
  assert.deepEqual(plan.options, { instagram: { trial: true, graduationStrategy: graduation } }, `options for ${graduation}`);
  assert.deepEqual(
    plan.extras.platformSpecificData,
    { contentType: "reels", trialParams: { graduationStrategy: graduation } },
    `a short reel declares itself and carries the ${graduation} trial`,
  );
}

// Past the reel declaration limit it is still a reel, and still a trial.
const long = trialReelPlan({ graduation: "MANUAL", format: "short_form", durationSec: 240, caption: "Words" });
assert.deepEqual(long.extras.platformSpecificData, { trialParams: { graduationStrategy: "MANUAL" } }, "a 4 minute reel keeps its trial");

/* ---- which failed downloads are tried again ---- */

for (const status of [0, 429, 500, 503]) {
  assert.equal(downloadRetries(new DriveError(status, "x")), true, `${status} lets go of the claim`);
}
for (const status of [400, 403, 404, 413, 415]) {
  assert.equal(downloadRetries(new DriveError(status, "x")), false, `${status} is final for that file`);
}
assert.equal(downloadRetries(new Error("disk")), true, "a local failure is tried again");

/* ---- which transcription failures are tried again ---- */

for (const msg of [
  "the transcription service did not answer (connect ECONNREFUSED 127.0.0.1:4710)",
  "transcription timed out after 45 min",
  "transcription failed: 502 Bad Gateway",
  "transcription failed: 503 loading",
  "transcription failed: 504 ",
]) {
  assert.equal(transcriptionRetries(new Error(msg)), true, `tried again: ${msg}`);
}
for (const msg of [
  `transcription failed: 500 {"detail":"Command '['ffmpeg', ...]' returned non-zero exit status 1."}`,
  "transcription failed: 422 bad request",
  "transcription failed: 5000 odd",
  "transcription failed: the service sent something that is not JSON",
]) {
  assert.equal(transcriptionRetries(new Error(msg)), false, `about this file, held: ${msg}`);
}

/* ---- a save during a check ---- */

const saved = readDriveSource({
  on: true, folderId: "1AbCdEfGhIjKlMnOpQ", socialAccountIds: ["acc1", "acc2"], graduation: "MANUAL", mode: "live",
  linkedAt: "2026-11-08T10:00:00Z", lastCheckAt: "2026-11-08T10:05:00Z", lastResult: "ok",
});
assert.equal(settingsMoved(saved, { ...saved }), false, "nothing saved, nothing moved");
assert.equal(
  settingsMoved(saved, { ...saved, lastCheckAt: "2026-11-08T10:10:00Z", lastResult: "1 scheduled.", link: "x" }),
  false,
  "the check's own fields are not a save",
);
assert.equal(settingsMoved(saved, { ...saved, socialAccountIds: ["acc2", "acc1"] }), false, "the same accounts in another order");
for (const moved of [
  { on: false },
  { mode: "dryrun" as const },
  { socialAccountIds: ["acc1"] },
  { socialAccountIds: ["acc1", "acc3"] },
  { socialAccountIds: ["acc1", "acc2", "acc3"] },
  { socialAccountIds: [] },
  { graduation: "SS_PERFORMANCE" as const },
  { linkedAt: "2026-11-08T11:00:00Z" },
]) {
  assert.equal(settingsMoved(saved, { ...saved, ...moved }), true, `a save of ${JSON.stringify(moved)} stops the post`);
}

/* ---- which ticked accounts a video posts to ---- */

const acct = (id: string, extra: object = {}) => ({
  id,
  clientId: "c1",
  handle: id,
  platform: "instagram",
  status: "connected",
  deletedAt: null as Date | null,
  tokensEncrypted: "provider:zernio",
  ...extra,
});
const found = [
  acct("dudthecarguy"),
  acct("dud.rents_"),
  acct("reminder", { tokensEncrypted: "reminder" }),
  acct("stale", { status: "needs_reconnect" }),
  acct("gone", { deletedAt: new Date() }),
  acct("tiktok", { platform: "tiktok" }),
  acct("theirs", { clientId: "c2" }),
];
const handles = (r: ReturnType<typeof driveTargets>) => r.eligible.map((a) => a.handle);

const both = driveTargets("c1", ["dud.rents_", "dudthecarguy"], found, "live");
assert.deepEqual(handles(both), ["dud.rents_", "dudthecarguy"], "every eligible account, in the order ticked");
assert.deepEqual(both.skipped, [], "nothing skipped");

const live = driveTargets("c1", ["dudthecarguy", "reminder", "stale", "gone", "tiktok", "theirs", "missing"], found, "live");
assert.deepEqual(handles(live), ["dudthecarguy"], "only the eligible one posts");
assert.deepEqual(live.skipped, [
  "@reminder is not connected through the publishing provider",
  "@stale is not connected",
  "@gone was removed",
  "an account that is no longer one of this client's Instagram accounts",
  "an account that is no longer one of this client's Instagram accounts",
  "an account that is no longer one of this client's Instagram accounts",
], "each skip names its problem");
assert.ok(!live.skipped.some((n) => n.includes("@theirs") || n.includes("@tiktok")), "another client's or platform's handle is never named");

const dry = driveTargets("c1", ["dudthecarguy", "reminder"], found, "dryrun");
assert.deepEqual(handles(dry), ["dudthecarguy", "reminder"], "a dry run needs no provider connection");
assert.deepEqual(driveTargets("c1", ["stale", "gone"], found, "dryrun").eligible, [], "none eligible, none posted");
assert.deepEqual(driveTargets("c1", [], found, "live"), { eligible: [], skipped: [] }, "no ids, nothing");

console.log("drive.check.ts: ok");
