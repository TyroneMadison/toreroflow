import { parseAttempt, strandedVersion } from "./appUpdate";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  },
};

/**
 * The note that tells the operator an update did not land.
 *
 * On Windows the updater spawns the installer and immediately ends this
 * process, so nothing here is alive to notice the install failing. The note
 * written before the attempt is the only evidence that survives, which makes
 * two mistakes expensive and worth pinning:
 *
 * Crying wolf. Claiming an update failed when it worked teaches the operator
 * to ignore the banner, and then the real failure is invisible again.
 *
 * Staying quiet. Reading a note and deciding it means nothing is how this went
 * unnoticed across four releases in the first place.
 */

/* A note only counts if it says which version, and when. */
assert.deepEqual(
  parseAttempt(JSON.stringify({ version: "0.2.1", at: 1 })),
  { version: "0.2.1", at: 1 },
  "a complete note is read back",
);
assert.equal(parseAttempt(null), null, "no note at all is not a failure");
assert.equal(parseAttempt(""), null, "and neither is an empty one");
assert.equal(parseAttempt("{ this is not json"), null, "a corrupt note is ignored, not thrown on");
assert.equal(parseAttempt(JSON.stringify({ at: 1 })), null, "a note with no version says nothing");
assert.equal(
  parseAttempt(JSON.stringify({ version: "", at: 1 })),
  null,
  "an empty version is the same as none, not a stranded update to version ''",
);
assert.equal(
  parseAttempt(JSON.stringify({ version: "0.2.1" })),
  null,
  "a note with no timestamp is incomplete",
);

/* Stranded means: it tried to become a version, and it is not that version. */
assert.equal(
  strandedVersion({ version: "0.2.1", at: 1 }, "0.1.2"),
  "0.2.1",
  "still on the old version after trying is exactly the case worth reporting",
);
assert.equal(
  strandedVersion({ version: "0.2.1", at: 1 }, "0.2.1"),
  null,
  "running what it tried to become means the install worked, so say nothing",
);
assert.equal(strandedVersion(null, "0.1.2"), null, "no attempt, no complaint");
assert.equal(
  strandedVersion({ version: "0.2.1", at: 1 }, "0.3.0"),
  "0.2.1",
  "a version past the attempt is still not the attempt, so this stays truthy",
);
// That last one is why the banner only speaks when the stranded version is the
// one being offered right now. Somebody who gave up on 0.2.1 and hand-installed
// 0.3.0 leaves the note behind, and it must not follow them around complaining
// about an update they no longer need.

console.log("appUpdate.check: all checks passed");
