import { categoryByKey, EXPENSE_CATEGORIES } from "./expenseCategories";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

eq(EXPENSE_CATEGORIES.length, 15, "fifteen categories");

// Keys are stored in the database, so a rename is a migration, not a tweak.
const keys = EXPENSE_CATEGORIES.map((c) => c.key).join(",");
eq(
  keys,
  "advertising,car,contract_labor,depreciation,insurance,legal_professional,office,rent_other,repairs,supplies,travel,meals,utilities,software,other",
  "category keys and their order are fixed",
);

eq(new Set(EXPENSE_CATEGORIES.map((c) => c.key)).size, 15, "keys are unique");

// Software and other deliberately share Line 27a: Part V is a list of named
// other expenses, so they stay separate rows that sum to that line.
eq(categoryByKey("software")?.scheduleCLine, "27a", "software maps to Other expenses");
eq(categoryByKey("other")?.scheduleCLine, "27a", "other maps to Other expenses");
eq(categoryByKey("software")?.label, "Subscriptions and software", "software is its own label");
eq(categoryByKey("utilities")?.label, "Utilities", "utilities does not absorb software");
eq(categoryByKey("meals")?.scheduleCLine, "24b", "meals is line 24b");
eq(categoryByKey("nonsense"), null, "an unknown key returns null, it does not throw");

for (const c of EXPENSE_CATEGORIES) {
  if (!c.emoji) throw new Error(`category ${c.key} has no emoji`);
  if (!c.label) throw new Error(`category ${c.key} has no label`);
}

console.log("expenseCategories: all checks passed");
