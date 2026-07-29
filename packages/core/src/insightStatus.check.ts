import assert from "node:assert/strict";
import {
  INSIGHT_STATUSES,
  isInsightStatus,
  isReady,
  isRunning,
  type InsightStatus,
} from "./insightStatus";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * What this exists to prevent: the enqueue guard and the modal's poll
 * condition are the same question asked in two processes. If they ever
 * disagree, either a second Anthropic call gets billed on a double click, or
 * the modal spins forever on a run that already finished.
 */

assert.deepEqual([...INSIGHT_STATUSES], ["running", "ready", "failed"], "statuses changed");

for (const s of INSIGHT_STATUSES) {
  assert.equal(isInsightStatus(s), true, `${s} should be a valid status`);
}
assert.equal(isInsightStatus("done"), false, "unknown strings are not statuses");
assert.equal(isInsightStatus(null), false, "null is not a status");
assert.equal(isInsightStatus(undefined), false, "undefined is not a status");

// Exactly one status means work is in flight.
const running = INSIGHT_STATUSES.filter((s: InsightStatus) => isRunning(s));
assert.deepEqual(running, ["running"], "more than one status counts as in flight");

// A client that has never generated one has no row at all, and that must read
// as "not running" so the button stays pressable.
assert.equal(isRunning(null), false, "no row means not running");
assert.equal(isRunning(undefined), false, "no row means not running");

// An unrecognised status must never wedge the button or spin the poll.
assert.equal(isRunning("queued"), false, "unknown status must not count as running");
assert.equal(isReady("queued"), false, "unknown status must not count as ready");

assert.equal(isReady("ready"), true, "ready is ready");
assert.equal(isReady("failed"), false, "failed is not ready");
assert.equal(isReady(null), false, "no row is not ready");

// Failed is terminal: it is neither in flight nor a result to render.
assert.equal(isRunning("failed"), false, "failed is not still running");

console.log("insightStatus: all checks passed");
