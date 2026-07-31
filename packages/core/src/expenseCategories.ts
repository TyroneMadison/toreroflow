/**
 * Expense categories are the IRS Schedule C Part II lines, not an invented
 * taxonomy.
 *
 * Consumer finance apps use personal-finance categories a CPA then has to
 * translate. If the app's categories are the form's own lines, the year-end
 * export needs no translation at all.
 *
 * `key` is stored in the database. Renaming one is a migration, not an edit.
 */

export interface ExpenseCategory {
  key: string;
  /**
   * Schedule C Part II line, as printed on the form. Empty when the category
   * is not a business deduction and therefore belongs on no line at all.
   */
  scheduleCLine: string;
  label: string;
  emoji: string;
  /**
   * Whether money in this category reduces taxable profit.
   *
   * False for money that leaves the account without being an expense. Buying
   * an investment is a transfer of value, not a cost of doing business, and
   * the IRS does not let you deduct it. Tracking it here is useful; deducting
   * it is a wrong return, so the flag exists to keep the two apart.
   */
  deductible?: false;
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { key: "advertising", scheduleCLine: "8", label: "Advertising", emoji: "📣" },
  { key: "car", scheduleCLine: "9", label: "Car and truck", emoji: "🚗" },
  { key: "contract_labor", scheduleCLine: "11", label: "Contract labor", emoji: "👷" },
  { key: "depreciation", scheduleCLine: "13", label: "Equipment", emoji: "📷" },
  { key: "insurance", scheduleCLine: "15", label: "Insurance", emoji: "🛡" },
  { key: "legal_professional", scheduleCLine: "17", label: "Legal and professional", emoji: "⚖️" },
  { key: "office", scheduleCLine: "18", label: "Office", emoji: "📎" },
  { key: "rent_other", scheduleCLine: "20b", label: "Rent", emoji: "🏢" },
  { key: "repairs", scheduleCLine: "21", label: "Repairs", emoji: "🔧" },
  { key: "supplies", scheduleCLine: "22", label: "Supplies", emoji: "📦" },
  { key: "travel", scheduleCLine: "24a", label: "Travel", emoji: "✈️" },
  { key: "meals", scheduleCLine: "24b", label: "Meals", emoji: "🍽" },
  { key: "utilities", scheduleCLine: "25", label: "Utilities", emoji: "💡" },
  // No dedicated line exists for software. Line 27a is itemised by
  // description in Part V, so this stays a named entry rather than an
  // opaque total. Software is typically the largest expense here and needs its
  // own row to avoid being buried inside a generic Other bucket.
  { key: "software", scheduleCLine: "27a", label: "Subscriptions and software", emoji: "💻" },
  { key: "other", scheduleCLine: "27a", label: "Other", emoji: "📌" },
  // Deliberately last, and deliberately not on a line. Money put into an
  // investment is not deductible: it buys an asset rather than paying for
  // something consumed. Kept as a category so the account still balances
  // against the bank feed, and excluded from every deductible total.
  { key: "investments", scheduleCLine: "", label: "Investments", emoji: "📈", deductible: false },
];

const BY_KEY = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

/** Null rather than a throw: an unknown key is bad data, not a crash. */
export function categoryByKey(key: string): ExpenseCategory | null {
  return BY_KEY.get(key) ?? null;
}
