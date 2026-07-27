import { deductibleCents, formatCents, MEALS_DEDUCTIBLE_RATE, sumCents } from "./money";

/** Local assert so the file typechecks with the app and needs no node types. */
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

eq(formatCents(0), "$0.00", "zero formats with cents");
eq(formatCents(5999), "$59.99", "cents are not rounded away");
eq(formatCents(355000), "$3,550.00", "thousands are separated");
eq(formatCents(null), "-", "unknown is a dash, never a zero");

eq(sumCents([5999, 14820, 7900]), 28719, "sums exactly, no float drift");
eq(sumCents([5999, null, 7900]), 13899, "a null amount is skipped, not treated as zero");
eq(sumCents([]), 0, "an empty list sums to zero");

// The rule that has real tax consequences.
eq(MEALS_DEDUCTIBLE_RATE, 0.5, "meals are 50% deductible for 2026");
eq(deductibleCents("meals", 8460), 4230, "a meal is halved for the export");
eq(deductibleCents("meals", 8461), 4230, "halving floors rather than inventing a cent");
eq(deductibleCents("software", 8460), 8460, "everything else is fully deductible");
eq(deductibleCents("travel", 10000), 10000, "travel is not a meal");

console.log("money: all checks passed");
