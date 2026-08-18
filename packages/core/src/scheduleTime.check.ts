// The grace window is the whole subtlety here. Too strict and the app's own
// "Post now" button is rejected by its own guard; too loose and "yesterday"
// gets through, which publishes a client's video immediately.
import assert from "node:assert/strict";
import { SCHEDULE_GRACE_MS, isSchedulable, scheduleTimeError } from "./scheduleTime";

const now = new Date("2026-08-18T12:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms);

// The future is fine, obviously.
assert.equal(scheduleTimeError(at(60 * 60_000), now), null, "an hour out");
assert.equal(scheduleTimeError(at(10 * 60_000), now), null, "ten minutes out");
assert.equal(scheduleTimeError(now, now), null, "this exact instant");

/*
 * "Post now" sends new Date() from the operator's machine and arrives a moment
 * later, so by the time the server judges it, it is already in the past. This
 * is the case a naive `when > now` test breaks, and it breaks the publish
 * button rather than anything obviously scheduling-shaped.
 */
assert.equal(scheduleTimeError(at(-1500), now), null, "a request in flight");
assert.equal(scheduleTimeError(at(-30_000), now), null, "half a minute of clock skew");
assert.equal(scheduleTimeError(at(-SCHEDULE_GRACE_MS), now), null, "exactly at the edge");

// Past the grace, it is a real mistake and gets refused.
assert.equal(
  scheduleTimeError(at(-SCHEDULE_GRACE_MS - 1), now),
  "That time has already passed. Pick a time from now on.",
  "one millisecond past the edge",
);
assert.equal(isSchedulable(at(-5 * 60_000), now), false, "five minutes ago");
assert.equal(isSchedulable(at(-24 * 60 * 60_000), now), false, "yesterday");

// Earlier today counts, which is the case the old picker allowed: it floored
// minDate to the start of the day, so 9am was selectable at 4pm.
assert.equal(
  isSchedulable(new Date("2026-08-18T09:00:00.000Z"), now),
  false,
  "this morning is still the past",
);
assert.equal(
  isSchedulable(new Date("2026-08-18T23:59:00.000Z"), now),
  true,
  "later today is fine",
);

// A garbage date is rejected with its own message rather than reading as past.
const bad = scheduleTimeError(new Date("not a date"), now);
assert(bad !== null && bad.includes("valid"), "an invalid date says so");

console.log("scheduleTime.check: all checks passed");
