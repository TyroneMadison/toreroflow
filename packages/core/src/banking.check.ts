import assert from "node:assert/strict";
import {
  directionOf,
  isCashAccount,
  monthKeyOf,
  signedCents,
  toCents,
  totalsByMonth,
  totalsFor,
} from "./banking";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The rows below are real amounts from a live Plaid sandbox feed, kept
 * verbatim. The property being defended is that spending never counts as
 * income: Plaid reports a positive amount when money LEAVES the account, so
 * reading it the intuitive way inverts every figure while still looking
 * entirely plausible on screen.
 */

/* ---- the inversion, which is the whole point of this module ---- */

// Real outgoings from the sandbox feed, all reported positive.
for (const spend of [6.33, 5.4, 12, 4.33, 89.4, 25]) {
  assert.equal(directionOf(spend), "out", `${spend} is money leaving the account`);
  assert.equal(signedCents(spend) < 0, true, `${spend} must be negative in our convention`);
}

// Real money arriving, reported negative: a refund and an interest payment.
for (const income of [-500, -4.22]) {
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
  { amount: 6.33, date: "2026-07-26" },
  { amount: 5.4, date: "2026-07-13" },
  { amount: -500, date: "2026-07-11" },
  { amount: 12, date: "2026-07-10" },
  { amount: 4.33, date: "2026-07-10" },
  { amount: 89.4, date: "2026-07-09" },
  { amount: -4.22, date: "2026-07-08" },
];

{
  const t = totalsFor(feed);
  assert.equal(t.inCents, 50422, "500.00 refund plus 4.22 interest");
  assert.equal(t.outCents, 11746, "6.33 + 5.40 + 12.00 + 4.33 + 89.40");
  assert.equal(t.netCents, 50422 - 11746);
  assert.equal(t.counted, 7);
  // Money in and money out are both non-negative magnitudes.
  assert.equal(t.inCents >= 0 && t.outCents >= 0, true);
}

/* Pending rows are excluded unless asked for, because they can restate. */
{
  const withPending = [...feed, { amount: 999, date: "2026-07-27", pending: true }];
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
    { amount: 10, date: "2026-06-30" },
    { amount: 20, date: "2026-07-01" },
    { amount: -50, date: "2026-07-31" },
  ];
  const byMonth = totalsByMonth(spread);
  assert.equal(byMonth.size, 2);
  assert.equal(byMonth.get("2026-06")!.outCents, 1000);
  assert.equal(byMonth.get("2026-07")!.outCents, 2000);
  assert.equal(byMonth.get("2026-07")!.inCents, 5000);
}

/* ---- which accounts count ---- */

// A sandbox item returns twelve accounts; only cash belongs in cash flow.
assert.equal(isCashAccount("depository"), true);
assert.equal(isCashAccount("Depository"), true);
for (const t of ["credit", "loan", "investment", "brokerage", "other", null, undefined, ""]) {
  assert.equal(isCashAccount(t), false, `${String(t)} must not count as cash`);
}

console.log("banking: all checks passed");
