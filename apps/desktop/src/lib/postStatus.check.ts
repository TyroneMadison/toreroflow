import { canMove, POST_STATUS, type PostStatus, type StatusMeta } from "./postStatus";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  ok(value: unknown, message: string) {
    if (!value) throw new Error(message);
  },
};

/**
 * Runnable check for the calendar's status language:
 * `pnpm --filter @toreroflow/desktop test`.
 *
 * What this exists to prevent: the drag rule lived in four components and in
 * the API at once. A calendar that shows an open padlock on something the
 * server refuses to move is worse than one that shows nothing, so the icon
 * and the rule are pinned to each other here.
 */

const ALL: PostStatus[] = ["scheduled", "publishing", "posted", "failed"];

const expected: Record<PostStatus, Pick<StatusMeta, "movable" | "pulses" | "icon">> = {
  scheduled: { movable: true, pulses: false, icon: "unlock" },
  publishing: { movable: false, pulses: true, icon: "lock" },
  posted: { movable: false, pulses: false, icon: "lock" },
  failed: { movable: false, pulses: true, icon: "alert" },
};

for (const status of ALL) {
  const meta = POST_STATUS[status];
  assert.ok(meta, `${status} has no entry in POST_STATUS`);
  assert.equal(meta.movable, expected[status].movable, `${status} movability changed`);
  assert.equal(meta.pulses, expected[status].pulses, `${status} pulse changed`);
  assert.equal(meta.icon, expected[status].icon, `${status} icon changed`);
  assert.ok(meta.label.length > 0, `${status} has no label`);
  assert.ok(meta.hint.length > 0, `${status} has no hint`);
  assert.equal(canMove(status), meta.movable, `canMove disagrees with POST_STATUS for ${status}`);
}

// Exactly one status may be dragged. Making a posted or publishing card
// movable would invite a drag the API answers with a 409.
assert.equal(ALL.filter((s) => canMove(s)).length, 1, "more than one status is movable");
assert.equal(canMove("scheduled"), true, "scheduled must stay movable");

// The padlock and the rule can never contradict each other: anything that
// cannot move shows a closed lock or the failure marker, and the only thing
// that can move shows the open one.
for (const status of ALL) {
  const { movable, icon } = POST_STATUS[status];
  assert.equal(icon === "unlock", movable, `${status} icon does not match its drag rule`);
  if (!movable) assert.ok(icon === "lock" || icon === "alert", `${status} has no locked marker`);
}

// Motion is reserved for what is live or broken. Finished and waiting work
// stays still, or a full calendar becomes a strobe and nothing stands out.
assert.equal(POST_STATUS.posted.pulses, false, "posted must not pulse");
assert.equal(POST_STATUS.scheduled.pulses, false, "scheduled must not pulse");

// The legend reads in lifecycle order, and it maps this record directly.
assert.equal(
  Object.keys(POST_STATUS).join(","),
  "scheduled,publishing,posted,failed",
  "legend order changed",
);

console.log("postStatus.check.ts: all checks passed");
