/**
 * Turning a bank feed into money in and money out.
 *
 * Two things here are worth more than the code around them.
 *
 * First, the sign convention. SimpleFIN signs amounts the intuitive way:
 * **positive is money arriving**, negative is money leaving. That is the
 * opposite of the provider this replaced, which reported a positive amount
 * when money left, so the flip that used to live here is gone. It is written
 * down rather than assumed because getting it backwards reports spending as
 * income, which looks plausible on a screen and ends up on a tax return.
 *
 * Second, the feed is decimal dollars (`-33.24`) while every other figure in
 * this app is integer cents. Mixing the two is how totals drift by a penny
 * and then by more.
 */

/** Our own convention, kept explicit so nobody has to remember the provider's. */
export type MoneyDirection = "in" | "out";

/**
 * Which way the money went.
 *
 * Zero counts as "out": a zero-amount row is not income, and treating it as
 * such would put it in a revenue total.
 */
export function directionOf(feedAmount: number): MoneyDirection {
  return feedAmount > 0 ? "in" : "out";
}

/**
 * Dollars to integer cents.
 *
 * Rounded half away from zero so a feed that reports 0.005 does not
 * disappear, and applied to the absolute value first so negative amounts
 * round identically to positive ones rather than towards minus infinity.
 */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  const sign = dollars < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(dollars) * 100);
}

/**
 * Cents in **our** convention: positive means money arrived.
 *
 * The single place the feed's amount becomes our number. It happens to be a
 * straight conversion now that the provider signs the same way we do, and it
 * stays a named function anyway: everything downstream reads this rather than
 * the raw amount, so a future provider that inverts again is one line here
 * instead of a hunt through the app.
 */
export function signedCents(feedAmount: number): number {
  const cents = toCents(feedAmount);
  // Guard against -0, which sums fine but fails identity checks and
  // serialises as "-0". Not worth leaving for someone to trip over.
  return cents === 0 ? 0 : cents;
}

export interface BankFlowRow {
  /** The provider's raw amount, in dollars, unmodified. */
  amount: number;
  /** ISO date, "2026-07-26". */
  date: string;
  pending?: boolean;
}

export interface BankFlowTotals {
  inCents: number;
  outCents: number;
  netCents: number;
  /** Rows counted, so a total of zero can be told apart from no data. */
  counted: number;
}

/**
 * Money in, money out and the net, in cents.
 *
 * Pending rows are excluded by default. A pending charge can change amount or
 * vanish, and a figure that quietly restates itself is worse than one that
 * arrives a day late.
 */
export function totalsFor(rows: BankFlowRow[], includePending = false): BankFlowTotals {
  let inCents = 0;
  let outCents = 0;
  let counted = 0;
  for (const r of rows) {
    if (r.pending && !includePending) continue;
    counted += 1;
    const cents = signedCents(r.amount);
    if (cents > 0) inCents += cents;
    else outCents += -cents;
  }
  return { inCents, outCents, netCents: inCents - outCents, counted };
}

/**
 * The calendar day an instant fell on, in the business's own timezone.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC. The date column
 * is text precisely so a transaction cannot slide into the wrong month
 * depending on who is reading it, and filing a Thursday-evening payment under
 * Friday because the writer was on a UTC clock is that same off-by-one coming
 * in the other door. For anyone west of Greenwich it is every transaction after
 * early evening, and at a month boundary it moves money between months.
 *
 * en-CA is the locale that formats as YYYY-MM-DD, which is what the column
 * holds and what its range queries assume.
 */
export function businessDay(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
  } catch {
    // An unrecognised zone should not stop a bank sync. UTC is the same
    // behaviour as before this function existed.
    return instant.toISOString().slice(0, 10);
  }
}

/** "2026-07" for a row, for bucketing a feed by month. */
export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * The first day of the month a window of `months` ending today starts on,
 * as "2026-02-01".
 *
 * Done with plain arithmetic rather than `Date.setMonth`, which clamps by
 * rolling **forward**: on 29 July, six months back is 29 February, a date that
 * does not exist in 2026, so it becomes 1 March and the window quietly loses a
 * month. Every date after the 28th hits this, which is most of the month.
 */
export function monthWindowStart(months: number, today = new Date()): string {
  const span = Math.max(1, Math.trunc(months));
  const shifted = today.getFullYear() * 12 + today.getMonth() - (span - 1);
  const year = Math.floor(shifted / 12);
  const month = shifted - year * 12;
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** Totals per calendar month, keyed "2026-07". */
export function totalsByMonth(
  rows: BankFlowRow[],
  includePending = false,
): Map<string, BankFlowTotals> {
  const out = new Map<string, BankFlowRow[]>();
  for (const r of rows) {
    const key = monthKeyOf(r.date);
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return new Map([...out].map(([k, v]) => [k, totalsFor(v, includePending)]));
}

/**
 * Whether a newly discovered account should count as business cash flow by
 * default.
 *
 * SimpleFIN does not report an account type, so there is nothing to decide
 * from: a checking account and a credit card arrive looking the same. Every
 * account therefore starts counted, and the operator unticks the ones that
 * should not be, which the per-account toggle already does.
 *
 * The alternative, guessing from the account's name, would be wrong quietly.
 * A default that is visibly too generous beats one that silently drops the
 * account the business actually runs on.
 */
export function defaultsToCashFlow(): boolean {
  return true;
}
