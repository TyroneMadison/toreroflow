// The A/B math runs unattended for a week per test and rewrites a client's
// live thumbnail at the end, so the decision logic is pinned here: which
// variant is due when, what counts as a measurement, and what never counts
// as a verdict.
import assert from "node:assert/strict";
import { abResult, abTestFrom, dueSlot, viewsPerDay } from "./abThumbs";

const test = { periodDays: 5, startedAt: "2026-08-18T12:00:00.000Z" };
const at = (days: number) => new Date(Date.parse(test.startedAt) + days * 24 * 60 * 60 * 1000);

// The rotation calendar: A first, B at one period, finish at two.
assert.equal(dueSlot(test, at(0)), "a", "the test opens on A");
assert.equal(dueSlot(test, at(4.9)), "a", "A holds its whole window");
assert.equal(dueSlot(test, at(5)), "b", "B takes over exactly at the boundary");
assert.equal(dueSlot(test, at(9.9)), "b", "B holds its whole window");
assert.equal(dueSlot(test, at(10)), "finish", "two windows and it is over");
assert.equal(dueSlot(test, at(45)), "finish", "long after, still just over");

// Views/day from cumulative captures: the delta over the days between the
// first and last capture inside the window.
{
  const rows = [
    { capturedOn: at(0), views: 1000 },
    { capturedOn: at(1), views: 1400 },
    { capturedOn: at(2), views: 1900 },
    { capturedOn: at(3), views: 2200 },
    { capturedOn: at(4), views: 2600 },
  ];
  assert.equal(viewsPerDay(rows, at(0), at(5)), 400, "(2600-1000)/4 days");
}

// One capture is not a rate, and a rate of null must never read as zero.
{
  const rows = [{ capturedOn: at(1), views: 1400 }];
  assert.equal(viewsPerDay(rows, at(0), at(5)), null, "a single capture measures nothing");
  assert.equal(viewsPerDay([], at(0), at(5)), null, "no captures measure nothing");
}

// Captures outside the window stay outside: the B window must not read A's.
{
  const rows = [
    { capturedOn: at(0), views: 1000 },
    { capturedOn: at(4), views: 2600 },
    { capturedOn: at(5), views: 2800 },
    { capturedOn: at(9), views: 4400 },
  ];
  assert.equal(viewsPerDay(rows, at(5), at(10)), 400, "B reads only its own days");
  assert.equal(viewsPerDay(rows, at(0), at(5)), 400, "and A only its own");
}

// Verdicts. A missing window is no verdict; a tie is no verdict; the note
// always names the views/day confound rather than dressing it up as CTR.
{
  assert.equal(abResult(400, null).winner, null, "no data, no winner");
  assert.equal(abResult(null, 400).winner, null, "either side");
  assert.equal(abResult(400, 400).winner, null, "a tie names nobody");
  const b = abResult(300, 420);
  assert.equal(b.winner, "b", "the higher rate wins");
  assert.equal(b.note.includes("impressions volume"), true, "the confound is stated in the verdict itself");
  const a = abResult(500, 420);
  assert.equal(a.winner, "a", "in either direction");
}

// The stored-shape reader refuses anything that could not actually run.
assert.equal(abTestFrom(null), null);
assert.equal(abTestFrom({ youtube: {} }), null);
assert.equal(
  abTestFrom({ youtube: { abTest: { periodDays: 5, startedAt: "x", variants: { a: { key: "k" } } } } }),
  null,
  "one variant is not a test",
);
assert.notEqual(
  abTestFrom({
    youtube: {
      abTest: {
        periodDays: 5,
        startedAt: "2026-08-18T12:00:00.000Z",
        variants: { a: { key: "c/x/ab-a.jpg" }, b: { key: "c/x/ab-b.jpg" } },
        applied: null,
        state: "running",
      },
    },
  }),
  null,
  "a complete test parses",
);

console.log("abThumbs.check: all checks passed");
