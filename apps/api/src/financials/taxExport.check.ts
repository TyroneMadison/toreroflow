import { groupForScheduleC, labelFor, uncategorisedExpenses } from "./taxExport";

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

// A row with a bad categoryLine (predating the enum validation in
// financeSchemas.ts) must not turn up inside a known group...
const withTypo = [
  ...expenses,
  { name: "Random Store", categoryLine: "softwares", amountCents: 2500 },
  { name: "No amount yet", categoryLine: "made_up_key", amountCents: null },
];
const groupsWithTypo = groupForScheduleC(withTypo);
eq(
  groupsWithTypo.find((g) => g.key === "software")!.totalCents,
  20819,
  "an unrecognised categoryLine does not fall into a real group by accident",
);

// ...but it also must not vanish. It has to be collected separately.
const uncategorised = uncategorisedExpenses(withTypo);
eq(uncategorised.length, 1, "only the priced bad-category row is collected");
eq(uncategorised[0]!.name, "Random Store", "the priced row is the one carried over");
eq(
  uncategorised.some((u) => u.categoryLine === "made_up_key"),
  false,
  "a bad category with no amount yet is excluded, same rule as everywhere else",
);
eq(labelFor("softwares"), "softwares", "an unknown key has no catalogue label, so it echoes back");
eq(labelFor("software"), "Subscriptions and software", "a known key resolves to its real label");

console.log("taxExport: all checks passed");
