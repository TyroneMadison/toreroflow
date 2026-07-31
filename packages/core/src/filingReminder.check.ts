import assert from "node:assert/strict";
import { buildReminder, daysUntilFiling, filingReminderFor } from "./filingReminder";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * A missed State filing costs penalties and can dissolve the company, so the
 * two things worth defending here are that the reminder fires on every day it
 * is supposed to, and that it stays silent for an operator who has not set the
 * app up yet. A reminder that cries wolf on day one is one nobody reads in
 * April.
 */

const on = (month: number, day: number) => new Date(2027, month - 1, day, 9, 0, 0);
const ready = { taxDetailsSet: true, bankConnected: true };

// Every escalation day speaks.
for (const [month, day] of [
  [4, 1],
  [4, 10],
  [4, 15],
  [4, 20],
  [5, 1],
] as Array<[number, number]>) {
  const r = filingReminderFor({ today: on(month, day), ...ready });
  assert.ok(r, `${month}/${day} is a reminder day`);
  assert.equal(r!.key, "llc_annual_filing:2027", "one row per year, so repeats update rather than stack");
}

// And the days between them do not, so the reminder the operator already
// dismissed stays dismissed instead of reappearing every morning.
for (const [month, day] of [
  [3, 31],
  [4, 2],
  [4, 9],
  [4, 16],
  [4, 30],
  [5, 2],
  [11, 15],
] as Array<[number, number]>) {
  assert.equal(
    filingReminderFor({ today: on(month, day), ...ready }),
    null,
    `${month}/${day} has nothing new to say`,
  );
}

// The gate. Both halves are required, because either alone can be true of an
// operator who is still setting up.
assert.equal(
  filingReminderFor({ today: on(4, 1), taxDetailsSet: false, bankConnected: true }),
  null,
  "no tax details means the app does not know whose deadline this is",
);
assert.equal(
  filingReminderFor({ today: on(4, 1), taxDetailsSet: true, bankConnected: false }),
  null,
  "no bank means the app is not really in use yet",
);
assert.equal(
  filingReminderFor({ today: on(4, 1), taxDetailsSet: false, bankConnected: false }),
  null,
  "and neither is certainly not enough",
);

// Distance, counted in local days rather than from a UTC instant.
assert.equal(daysUntilFiling(on(5, 1)), 0, "the deadline itself is zero days away");
assert.equal(daysUntilFiling(on(4, 30)), 1, "the day before is one");
assert.equal(daysUntilFiling(on(4, 1)), 30, "the first warning is thirty days out");
assert.equal(daysUntilFiling(on(5, 2)), -1, "and the day after has passed");

// Tone escalates. A month out is a warning; the last stretch is an error, so
// the dock paints it red rather than amber.
assert.equal(buildReminder(2027, 30).severity, "warning", "a month out is information");
assert.equal(buildReminder(2027, 11).severity, "error", "eleven days out is urgent");
assert.equal(buildReminder(2027, 0).severity, "error", "and the day itself certainly is");
assert.match(buildReminder(2027, 0).message, /due today/, "the day itself says today, not 0 days away");
assert.match(buildReminder(2027, 30).message, /30 days away/, "and a month out counts down");
assert.match(buildReminder(2027, 1).message, /1 day away/, "one day, not 1 days");

console.log("filingReminder: all checks passed");
