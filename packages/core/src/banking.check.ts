import assert from "node:assert/strict";
import {
  businessDay,
  defaultsToCashFlow,
  directionOf,
  monthKeyOf,
  monthWindowStart,
  signedCents,
  toCents,
  totalsByMonth,
  totalsFor,
} from "./banking";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The property being defended is that spending never counts as income. It is
 * worth a check even though SimpleFIN signs amounts the obvious way, because
 * the provider this replaced signed them the other way round: a card payment
 * came through positive. Anyone porting an old snippet, or swapping providers
 * again, inverts every figure on the screen while it still looks plausible.
 */

/* ---- the sign convention, which is the whole point of this module ---- */

// Money leaving: card payments and bills, reported negative.
for (const spend of [-6.33, -5.4, -12, -4.33, -89.4, -25]) {
  assert.equal(directionOf(spend), "out", `${spend} is money leaving the account`);
  assert.equal(signedCents(spend) < 0, true, `${spend} must be negative in our convention`);
}

// Money arriving: a client payment and an interest credit, reported positive.
for (const income of [500, 4.22]) {
  assert.equal(directionOf(income), "in", `${income} is money arriving`);
  assert.equal(signedCents(income) > 0, true, `${income} must be positive in our convention`);
}

// Zero is not income.
assert.equal(directionOf(0), "out");
assert.equal(signedCents(0), 0);

/* ---- dollars to cents ---- */

assert.equal(toCents(6.33), 633);
assert.equal(toCents(89.4), 8940);
assert.equal(toCents(0.1), 10);
assert.equal(toCents(-500), -50000);
// Floats that cannot be represented exactly must still land on the right cent.
assert.equal(toCents(0.07), 7, "0.07 is famously 0.07000000000000001");
/*
 * A true half-cent lands wherever the float already sits.
 *
 * 1.005 cannot be represented exactly: it is 1.00499999999999989 before we
 * see it, because the amount arrives as a JSON number and the precision is
 * gone by then. So this rounds down, and negatives round symmetrically.
 * Chasing exact decimal behaviour here would be pretending to a precision
 * the input never had. Real transaction amounts carry two decimal places.
 */
assert.equal(toCents(1.005), 100, "1.005 is really 1.00499999999999989");
assert.equal(toCents(1.015), 101, "1.015 is really 1.01499999999999990");
/* When the half genuinely lands on .5, it rounds away from zero. */
assert.equal(toCents(0.005), 1);
assert.equal(toCents(2.675), 268);
/* Negatives round to the same magnitude as their positive twin, always. */
for (const v of [1.005, 1.015, 0.005, 2.675, 6.33, 89.4, 23631.9805]) {
  assert.equal(toCents(-v), -toCents(v), `${v} and -${v} must round to the same magnitude`);
}
assert.equal(toCents(320.76), 32076);
assert.equal(toCents(23631.9805), 2363198, "sub-cent precision is rounded, never truncated");
// Garbage in the feed becomes zero rather than NaN spreading through a total.
assert.equal(toCents(Number.NaN), 0);
assert.equal(toCents(Number.POSITIVE_INFINITY), 0);

/* ---- totals ---- */

const feed = [
  { amount: -6.33, date: "2026-07-26" },
  { amount: -5.4, date: "2026-07-13" },
  { amount: 500, date: "2026-07-11" },
  { amount: -12, date: "2026-07-10" },
  { amount: -4.33, date: "2026-07-10" },
  { amount: -89.4, date: "2026-07-09" },
  { amount: 4.22, date: "2026-07-08" },
];

{
  const t = totalsFor(feed);
  assert.equal(t.inCents, 50422, "500.00 payment in plus 4.22 interest");
  assert.equal(t.outCents, 11746, "6.33 + 5.40 + 12.00 + 4.33 + 89.40");
  assert.equal(t.netCents, 50422 - 11746);
  assert.equal(t.counted, 7);
  // Money in and money out are both non-negative magnitudes.
  assert.equal(t.inCents >= 0 && t.outCents >= 0, true);
}

/* Pending rows are excluded unless asked for, because they can restate. */
{
  const withPending = [...feed, { amount: -999, date: "2026-07-27", pending: true }];
  assert.equal(totalsFor(withPending).outCents, 11746, "pending must not be counted");
  assert.equal(totalsFor(withPending).counted, 7);
  assert.equal(totalsFor(withPending, true).outCents, 11746 + 99900);
  assert.equal(totalsFor(withPending, true).counted, 8);
}

/* An empty feed is zero with zero counted, distinguishable from no data. */
{
  const t = totalsFor([]);
  assert.deepEqual(t, { inCents: 0, outCents: 0, netCents: 0, counted: 0 });
}

/* Net is always in minus out, whatever the mix. */
for (const rows of [feed, [{ amount: -1, date: "2026-01-01" }], [{ amount: 1, date: "2026-01-01" }]]) {
  const t = totalsFor(rows);
  assert.equal(t.netCents, t.inCents - t.outCents);
}

/* ---- months ---- */

assert.equal(monthKeyOf("2026-07-26"), "2026-07");
{
  const spread = [
    { amount: -10, date: "2026-06-30" },
    { amount: -20, date: "2026-07-01" },
    { amount: 50, date: "2026-07-31" },
  ];
  const byMonth = totalsByMonth(spread);
  assert.equal(byMonth.size, 2);
  assert.equal(byMonth.get("2026-06")!.outCents, 1000);
  assert.equal(byMonth.get("2026-07")!.outCents, 2000);
  assert.equal(byMonth.get("2026-07")!.inCents, 5000);
}

/*
 * The window start, which must not depend on today's day of the month.
 *
 * `Date.setMonth` rolls a nonexistent day forward, so six months back from 29
 * July 2026 became 1 March instead of 1 February and the window lost a month.
 * Every day after the 28th hit it.
 */
{
  const jul29 = new Date(2026, 6, 29);
  assert.equal(monthWindowStart(6, jul29), "2026-02-01", "29 July must not skip February");
  assert.equal(monthWindowStart(1, jul29), "2026-07-01");
  assert.equal(monthWindowStart(12, jul29), "2025-08-01");
  assert.equal(monthWindowStart(24, jul29), "2024-08-01");
  // Crossing a year boundary backwards.
  assert.equal(monthWindowStart(3, new Date(2026, 0, 31)), "2025-11-01");
  // The 31st of a month whose target month is short: the old bug's home.
  assert.equal(monthWindowStart(2, new Date(2026, 2, 31)), "2026-02-01", "31 March, 2 months");
  assert.equal(monthWindowStart(2, new Date(2026, 4, 31)), "2026-04-01", "31 May, 2 months");
  // Same answer on every day of a month, which is the property that failed.
  for (let day = 1; day <= 31; day++) {
    assert.equal(
      monthWindowStart(6, new Date(2026, 6, day)),
      "2026-02-01",
      `July ${day} must give the same window start`,
    );
  }
  // A nonsense span never reaches into the future.
  assert.equal(monthWindowStart(0, jul29), "2026-07-01");
  assert.equal(monthWindowStart(-5, jul29), "2026-07-01");
}

/* ---- which accounts count ---- */

// SimpleFIN reports no account type, so a new account starts counted and the
// operator unticks what should not be. Pinned so nobody "fixes" it into a
// guess based on the account name, which would drop accounts silently.
assert.equal(defaultsToCashFlow(), true);

/*
 * The day a transaction is filed under.
 *
 * The case that matters is an evening payment west of Greenwich: 8pm on 31
 * July in New York is already 1 August in UTC, so filing by UTC moves it into
 * the next month and out of July's total. This is the check that fails if
 * anyone reaches for toISOString again.
 */
const evening = new Date("2026-08-01T00:30:00Z"); // 20:30 on 31 July in New York
assert.equal(businessDay(evening, "America/New_York"), "2026-07-31", "an evening payment stays in its own month");
assert.equal(businessDay(evening, "UTC"), "2026-08-01", "UTC really is the next day, which is the bug");
assert.equal(businessDay(evening, "America/Los_Angeles"), "2026-07-31", "and further west too");

// Just after midnight local is the same day, not the previous one.
const justAfterMidnight = new Date("2026-07-31T04:10:00Z"); // 00:10 on 31 July in New York
assert.equal(businessDay(justAfterMidnight, "America/New_York"), "2026-07-31");

// Shape, because the column is compared as text and sorted as text.
assert.match(businessDay(new Date("2026-01-05T12:00:00Z"), "America/New_York"), /^\d{4}-\d{2}-\d{2}$/);

// A zone the platform does not know must not take a bank sync down with it.
assert.equal(businessDay(evening, "Mars/Olympus_Mons"), "2026-08-01", "an unknown zone falls back to UTC");

console.log("banking: all checks passed");
