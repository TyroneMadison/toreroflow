import { categoryByKey, EXPENSE_CATEGORIES } from "./expenseCategories";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const EXPECTED_CATEGORIES_COUNT = 15;

eq(EXPENSE_CATEGORIES.length, EXPECTED_CATEGORIES_COUNT, "fifteen categories");

// Keys are stored in the database, so a rename is a migration, not a tweak.
const keys = EXPENSE_CATEGORIES.map((c) => c.key).join(",");
eq(
  keys,
  "advertising,car,contract_labor,depreciation,insurance,legal_professional,office,rent_other,repairs,supplies,travel,meals,utilities,software,other",
  "category keys and their order are fixed",
);

eq(new Set(EXPENSE_CATEGORIES.map((c) => c.key)).size, 15, "keys are unique");

/**
 * Every line number, pinned. A wrong number here does not fail loudly, it puts
 * a real expense on the wrong line of a real tax return, so the whole table is
 * asserted rather than a sample of it.
 */
const EXPECTED_LINES: Array<[string, string]> = [
  ["advertising", "8"],
  ["car", "9"],
  ["contract_labor", "11"],
  ["depreciation", "13"],
  ["insurance", "15"],
  ["legal_professional", "17"],
  ["office", "18"],
  ["rent_other", "20b"],
  ["repairs", "21"],
  ["supplies", "22"],
  ["travel", "24a"],
  ["meals", "24b"],
  ["utilities", "25"],
  ["software", "27a"],
  ["other", "27a"],
];
eq(EXPECTED_LINES.length, EXPECTED_CATEGORIES_COUNT, "line table covers every category");
for (const [key, line] of EXPECTED_LINES) {
  eq(categoryByKey(key)?.scheduleCLine, line, `${key} must report Schedule C line ${line}`);
}

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
