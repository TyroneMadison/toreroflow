// Drive trial reels decide what posts to a client's Instagram with nobody
// watching, so every refusal path is pinned here.
import assert from "node:assert/strict";
import { decideDriveAction, isDriveId, isDriveVideo, pickDriveFiles, readDriveSource, type DriveFile } from "./drive";

/* ---- settings ---- */

const FOLDER = "1AbCdEfGhIjKlMnOpQ";
assert.deepEqual(readDriveSource(null), {
  on: false, link: "", folderId: "", socialAccountId: "", graduation: "MANUAL", mode: "dryrun",
  linkedAt: null, lastCheckAt: null, lastResult: null,
}, "nothing stored reads as off, dry run, MANUAL");
assert.deepEqual(readDriveSource("junk"), readDriveSource(null), "a non-object never throws");
assert.deepEqual(readDriveSource([1]), readDriveSource(null), "an array is not settings");
const s = readDriveSource({
  on: true, link: "https://drive.google.com/drive/folders/" + FOLDER, folderId: FOLDER, socialAccountId: "acc1",
  graduation: "SS_PERFORMANCE", mode: "live", linkedAt: "2026-11-08T10:00:00Z", lastCheckAt: 5, lastResult: "ok",
});
assert.equal(s.on && s.mode === "live" && s.graduation === "SS_PERFORMANCE", true, "valid settings kept");
assert.equal(s.lastCheckAt, null, "a non-date lastCheckAt is dropped");
assert.equal(readDriveSource({ mode: "LIVE", graduation: "AUTO" }).mode, "dryrun", "only the exact word live goes live");
assert.equal(readDriveSource({ graduation: "AUTO" }).graduation, "MANUAL", "unknown graduation is MANUAL");
assert.equal(readDriveSource({ on: "true", folderId: FOLDER }).on, false, "on must be the boolean true");
assert.equal(readDriveSource({ on: true, folderId: "x' or '1'='1" }).on, false, "on needs a valid folder");
assert.equal(readDriveSource({ on: true, folderId: "x' or '1'='1" }).folderId, "", "a quoted folder id is dropped");
assert.equal(readDriveSource({ linkedAt: "soon" }).linkedAt, null, "an unreadable linkedAt is null");

/* ---- ids and file types ---- */

assert.equal(isDriveId(FOLDER), true);
for (const bad of ["short", "abc'defghijk", "abc/defghijk", "abc defghijk", "a".repeat(129)]) {
  assert.equal(isDriveId(bad), false, `refused: ${bad}`);
}
assert.equal(isDriveVideo({ name: "a", mimeType: "video/quicktime" }), true, "mov by type");
assert.equal(isDriveVideo({ name: "CLIP.MOV", mimeType: "application/octet-stream" }), true, "mov by name");
assert.equal(isDriveVideo({ name: "a.mkv", mimeType: "video/x-matroska" }), false, "other videos left alone");
assert.equal(isDriveVideo({ name: "a.mp4.jpg", mimeType: "image/jpeg" }), false, "extension must be last");

/* ---- picking new files ---- */

const f = (id: string, name: string, createdTime: string | null, mimeType: string | null = "video/mp4"): DriveFile =>
  ({ id: id.padEnd(12, "x"), name, mimeType, size: 1, createdTime });
const files = [
  f("c", "c.mp4", "2026-11-08T12:00:00Z"),
  f("old", "old.mp4", "2026-11-08T09:59:59Z"),
  f("a", "a.mov", "2026-11-08T10:00:00Z", "video/quicktime"),
  f("b", "b.mp4", "2026-11-08T11:00:00Z"),
  f("b", "b.mp4", "2026-11-08T11:00:00Z"),
  f("seen", "seen.mp4", "2026-11-08T11:30:00Z"),
  f("doc", "notes.pdf", "2026-11-08T11:00:00Z", "application/pdf"),
  f("nodate", "nodate.mp4", null),
  { id: "bad'id'xxxxxx", name: "q.mp4", mimeType: "video/mp4", size: 1, createdTime: "2026-11-08T11:00:00Z" },
];
const ids = (xs: DriveFile[]) => xs.map((x) => x.id.replace(/x+$/, ""));
const picked = pickDriveFiles(files, { linkedAt: "2026-11-08T10:00:00Z", seenFileIds: ["seenxxxxxxxx"] });
assert.deepEqual(ids(picked), ["a", "b", "c"], "new videos at or after linkedAt, oldest first, deduped");
assert.equal("at" in picked[0]!, false, "no sort key leaks into the result");
assert.deepEqual(pickDriveFiles(files, { linkedAt: null, seenFileIds: [] }), [], "not linked yet posts nothing");
assert.deepEqual(ids(pickDriveFiles(files, { linkedAt: "2026-11-08T11:00:00Z", seenFileIds: new Set(["bxxxxxxxxxxx"]) })), ["seen", "c"], "a Set works as seen");

/* ---- deciding ---- */

const ready = { status: "ready", format: "short_form", durationSec: 30, width: 1080, height: 1920, bytes: 50 * 1024 * 1024 };
const on = { on: true, socialAccountId: "acc1", mode: "dryrun" as const, linkedAt: "2026-11-08T10:00:00Z" };
const caption = "We take the ZR1X out for the first time.\n\n#zr1x #corvette";
const reasonOf = (a: ReturnType<typeof decideDriveAction>) => ("reason" in a ? a.reason : "");
const decide = (input: Omit<Parameters<typeof decideDriveAction>[0], "claimedAt"> & { claimedAt?: Date }) =>
  decideDriveAction({ claimedAt: new Date("2026-11-08T10:05:00Z"), ...input });

assert.deepEqual(decide({ asset: ready, caption, settings: on }), { kind: "post", mode: "dryrun" });
assert.deepEqual(decide({ asset: ready, caption, settings: { ...on, mode: "live" } }), { kind: "post", mode: "live" });
assert.deepEqual(
  decide({ asset: ready, caption, settings: on, claimedAt: new Date("2026-11-08T10:00:00Z") }),
  { kind: "post", mode: "dryrun" },
  "claimed the moment it was linked still posts",
);

// Switched off, then on again (or given a new folder): the clock restarts, and
// a video downloaded before that is held, not posted on the first check.
const earlier = decide({ asset: ready, caption, settings: { ...on, mode: "live" }, claimedAt: new Date("2026-11-08T09:59:59Z") });
assert.equal(earlier.kind, "hold", "a video claimed before linkedAt never posts");
assert.match(reasonOf(earlier), /downloaded before Drive auto-post was last switched on/);
assert.equal(decide({ asset: ready, caption, settings: { ...on, linkedAt: null } }).kind, "hold", "no linkedAt never posts");
assert.deepEqual(
  decide({ asset: ready, caption, settings: { ...on, on: false }, claimedAt: new Date(0) }),
  { kind: "wait" },
  "while off, an earlier video waits rather than being settled",
);

const failed = decide({ asset: { ...ready, status: "failed" }, caption, settings: on });
assert.equal(failed.kind, "fail", "a failed asset fails");
assert.match(reasonOf(failed), /fresh copy/);
for (const status of ["uploaded", "processing"]) {
  assert.deepEqual(decide({ asset: { ...ready, status }, caption, settings: on }), { kind: "wait" }, status);
}
assert.deepEqual(decide({ asset: ready, caption, settings: { ...on, on: false } }), { kind: "wait" }, "an off folder never posts");

const big = decide({ asset: { ...ready, bytes: 301 * 1024 * 1024 }, caption, settings: on });
assert.equal(big.kind, "skip", "over 300 MB is skipped");
assert.equal(
  reasonOf(big),
  "Instagram videos can be up to 15 minutes and 300 MB. This one is 301 MB. Re-export it at a lower bitrate, then add the new file to the Drive folder.",
);
const long = decide({ asset: { ...ready, durationSec: 16 * 60 }, caption, settings: on });
assert.equal(long.kind, "skip", "over 15 minutes is skipped");
assert.match(reasonOf(long), /16:00\. Trim it, then add the new file/);
assert.doesNotMatch(reasonOf(long), /untick/, "no schedule-screen wording");

const lf = decide({ asset: { ...ready, format: "long_form", width: 1920, height: 1080, durationSec: 600 }, caption, settings: on });
assert.equal(lf.kind, "hold", "long-form is held, never a plain trial reel");
assert.match(reasonOf(lf), /long-form/);
assert.equal(
  decide({ asset: { ...ready, format: null, width: 1920, height: 1080, durationSec: 600 }, caption, settings: on }).kind,
  "hold",
  "unset format falls back to the default format",
);
assert.equal(
  decide({ asset: { ...ready, format: null, durationSec: 600 }, caption, settings: on }).kind,
  "post",
  "a vertical video is short-form however long it runs",
);

assert.equal(decide({ asset: ready, caption, settings: { ...on, socialAccountId: "" } }).kind, "hold", "no account holds");
for (const none of [null, "", "  \n "]) {
  const held = decide({ asset: ready, caption: none, settings: on });
  assert.equal(held.kind, "hold", `never an empty caption: ${JSON.stringify(none)}`);
  assert.match(reasonOf(held), /No speech/);
}
const tooLong = decide({ asset: ready, caption: "a".repeat(2201), settings: on });
assert.equal(tooLong.kind, "hold", "a caption Instagram refuses is held");
assert.match(reasonOf(tooLong), /2,201 characters/);

console.log("drive: all checks passed");
