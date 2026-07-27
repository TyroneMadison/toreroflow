import { groupForScheduleC } from "./taxExport";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const expenses = [
  { name: "Adobe", categoryLine: "software", amountCents: 5999 },
  { name: "Anthropic", categoryLine: "software", amountCents: 14820 },
  { name: "Dinner", categoryLine: "meals", amountCents: 8460 },
  { name: "Internet", categoryLine: "utilities", amountCents: 7900 },
  { name: "Unentered", categoryLine: "software", amountCents: null },
];

const groups = groupForScheduleC(expenses);
const byKey = (k: string) => groups.find((g) => g.key === k)!;

eq(byKey("software").totalCents, 20819, "software sums its entered bills");
eq(byKey("software").deductibleCents, 20819, "software is fully deductible");
eq(byKey("software").items.length, 2, "an unentered bill is not an item");

// The rule with real tax consequences.
eq(byKey("meals").totalCents, 8460, "meals total is what was actually spent");
eq(byKey("meals").deductibleCents, 4230, "only half a meal may be claimed");

eq(byKey("utilities").scheduleCLine, "25", "utilities is line 25");
eq(byKey("software").scheduleCLine, "27a", "software reports under line 27a");

eq(groups.some((g) => g.totalCents === 0), false, "empty categories are omitted");

console.log("taxExport: all checks passed");
