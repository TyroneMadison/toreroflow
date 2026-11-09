import assert from "node:assert/strict";
import { DriveError } from "@toreroflow/publishers";
import { readDriveSource } from "@toreroflow/core";
import { downloadRetries, settingsMoved, transcriptionRetries, trialReelPlan } from "./drive";

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
  on: true, folderId: "1AbCdEfGhIjKlMnOpQ", socialAccountId: "acc1", graduation: "MANUAL", mode: "live",
  linkedAt: "2026-11-08T10:00:00Z", lastCheckAt: "2026-11-08T10:05:00Z", lastResult: "ok",
});
assert.equal(settingsMoved(saved, { ...saved }), false, "nothing saved, nothing moved");
assert.equal(
  settingsMoved(saved, { ...saved, lastCheckAt: "2026-11-08T10:10:00Z", lastResult: "1 scheduled.", link: "x" }),
  false,
  "the check's own fields are not a save",
);
for (const moved of [
  { on: false },
  { mode: "dryrun" as const },
  { socialAccountId: "acc2" },
  { graduation: "SS_PERFORMANCE" as const },
  { linkedAt: "2026-11-08T11:00:00Z" },
]) {
  assert.equal(settingsMoved(saved, { ...saved, ...moved }), true, `a save of ${JSON.stringify(moved)} stops the post`);
}

console.log("drive.check.ts: ok");
