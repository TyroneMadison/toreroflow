import { categoryByKey } from "./expenseCategories";

/**
 * Money arithmetic for the Financials module.
 *
 * Every amount in this system is integer cents. Floats and money do not mix:
 * a rounding artefact in a profit total is the kind of bug that costs trust in
 * the whole screen permanently, and it is unrecoverable once a client has been
 * invoiced from it.
 */

/** Business meals are 50% deductible for 2026. The 100% relief expired after 2022. */
export const MEALS_DEDUCTIBLE_RATE = 0.5;

/**
 * Cents as currency. Null means "not known", which renders as a dash rather
 * than $0.00, because an unentered bill is not a free one.
 */
export function formatCents(cents: number | null): string {
  if (cents === null) return "-";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Sums cents, skipping unknowns. Integer throughout, so no drift. */
export function sumCents(values: Array<number | null>): number {
  let total = 0;
  for (const v of values) if (v !== null) total += v;
  return total;
}

/**
 * What the tax export may claim for this expense.
 *
 * Meals are halved and floored. Flooring rather than rounding because
 * inventing a cent in your own favour on a tax document is the wrong
 * direction to be wrong in.
 */
export function deductibleCents(categoryKey: string, cents: number): number {
  // Some categories are not deductions at all. Investments is the one today:
  // the money left the account, but it bought an asset rather than paying for
  // anything, so claiming it would overstate the deduction and understate the
  // tax owed.
  if (categoryByKey(categoryKey)?.deductible === false) return 0;
  if (categoryKey !== "meals") return cents;
  return Math.floor(cents * MEALS_DEDUCTIBLE_RATE);
}
