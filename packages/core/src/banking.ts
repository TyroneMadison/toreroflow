/**
 * Turning a bank feed into money in and money out.
 *
 * Two things here are worth more than the code around them.
 *
 * First, the sign convention is inverted from intuition: Plaid reports a
 * **positive** amount when money leaves the account and a **negative** one
 * when it arrives. Verified against a live sandbox feed, where Uber and
 * McDonald's came back positive and a refund and an interest payment came
 * back negative. Reading it the intuitive way would report spending as
 * income, which is the kind of mistake that looks plausible on a screen and
 * ends up on a tax return.
 *
 * Second, the feed is floating point dollars (`23631.9805`) while every
 * other figure in this app is integer cents. Mixing the two is how totals
 * drift by a penny and then by more.
 */

/** Our own convention, kept explicit so nobody has to remember the provider's. */
export type MoneyDirection = "in" | "out";

/**
 * Which way the money went.
 *
 * Zero counts as "out": a zero-amount row is not income, and treating it as
 * such would put it in a revenue total.
 */
export function directionOf(plaidAmount: number): MoneyDirection {
  return plaidAmount < 0 ? "in" : "out";
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
 * The single place the provider's inversion is undone. Everything downstream
 * reads this rather than the raw amount, so the flip exists once.
 */
export function signedCents(plaidAmount: number): number {
  const cents = -toCents(plaidAmount);
  // Negating zero yields -0, which sums fine but fails identity checks and
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

/** "2026-07" for a row, for bucketing a feed by month. */
export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
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
 * Account types worth counting as business cash flow.
 *
 * Loans, investments and credit lines all report balances and transactions,
 * and folding a mortgage or a 401k into "money coming in" would make the
 * numbers meaningless. A sandbox item alone returns twelve accounts across
 * every type, so this filter is not hypothetical.
 */
export function isCashAccount(type: string | null | undefined): boolean {
  return (type ?? "").toLowerCase() === "depository";
}
