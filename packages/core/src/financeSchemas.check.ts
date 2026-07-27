import { expenseSchema, expenseUpdateSchema } from "./financeSchemas";

function ok(actual: boolean, message: string) {
  if (!actual) throw new Error(message);
}

const base = {
  name: "Adobe",
  amountCents: 5999,
  month: "2026-07",
  kind: "recurring" as const,
  variable: false,
};

// A real category passes.
ok(
  expenseSchema.safeParse({ ...base, categoryLine: "software" }).success,
  "a real category key must be accepted",
);

// A typo, or any string outside the catalogue, is rejected at the door: an
// unrecognised categoryLine is invisible to taxExport.ts's grouping, so
// letting it into the database would understate a deduction with nothing on
// screen to show for it.
ok(
  !expenseSchema.safeParse({ ...base, categoryLine: "softwares" }).success,
  "a category not in EXPENSE_CATEGORIES must be rejected",
);
ok(
  !expenseSchema.safeParse({ ...base, categoryLine: "" }).success,
  "an empty categoryLine must be rejected",
);

// Same rule on the update path, since a typo introduced by an edit is just
// as invisible to the export as one introduced at creation.
ok(
  expenseUpdateSchema.safeParse({ categoryLine: "meals" }).success,
  "a real category key must be accepted on update",
);
ok(
  !expenseUpdateSchema.safeParse({ categoryLine: "made_up_key" }).success,
  "an unrecognised category must be rejected on update",
);

console.log("financeSchemas: all checks passed");
