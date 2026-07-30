import assert from "node:assert/strict";
import { businessSchema, normalizeEin } from "./business";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The property being defended is that a tax identifier is either exactly right
 * or absent. A number that is quietly padded, truncated or reformatted still
 * prints confidently onto an invoice a client's accountant keeps and onto a
 * year-end export a CPA works from, and nothing on screen would say it was
 * changed.
 */

/* ---- the EIN, however it was copied ---- */

assert.equal(normalizeEin("12-3456789"), "12-3456789");
assert.equal(normalizeEin("123456789"), "12-3456789", "typed without the hyphen");
assert.equal(normalizeEin("  12-3456789  "), "12-3456789", "pasted with space around it");
assert.equal(normalizeEin("12 345 6789"), "12-3456789", "pasted out of a letter");

/* Anything that is not nine digits is refused, never made to fit. */
for (const bad of ["12-345678", "1234567890", "", "12-34567890", "abcdefghi", "12-345678a"]) {
  assert.equal(normalizeEin(bad), null, `"${bad}" must be refused rather than corrected`);
}

/* One stored form, so two documents can never disagree about the same number. */
assert.equal(normalizeEin("123456789"), normalizeEin("12-3456789"));

/* ---- what may be saved ---- */

{
  const parsed = businessSchema.parse({
    legalName: "  Torerone LLC  ",
    ein: "123456789",
    businessAddress: " 123 Example Ave\nMiami, FL ",
    businessCode: "541800",
    accountingMethod: "cash",
  });
  assert.equal(parsed.legalName, "Torerone LLC", "trimmed on the way in");
  assert.equal(parsed.ein, "12-3456789", "stored in one form");
  assert.equal(parsed.businessAddress, "123 Example Ave\nMiami, FL");
  assert.equal(parsed.businessCode, "541800");
  assert.equal(parsed.accountingMethod, "cash");
}

/* Blank is "not recorded", which is a real state and prints as such. */
{
  const parsed = businessSchema.parse({ legalName: "   ", ein: "", businessAddress: "" });
  assert.equal(parsed.legalName, null);
  assert.equal(parsed.ein, null);
  assert.equal(parsed.businessAddress, null);
}

/* A malformed EIN is rejected outright rather than stored as typed. */
for (const bad of ["12-345678", "not an ein", "12345678"]) {
  assert.equal(
    businessSchema.safeParse({ ein: bad }).success,
    false,
    `"${bad}" must not reach the database`,
  );
}

/* Six digits or nothing for the activity code, which is a line on the return. */
assert.equal(businessSchema.safeParse({ businessCode: "54180" }).success, false);
assert.equal(businessSchema.safeParse({ businessCode: "5418000" }).success, false);
assert.equal(businessSchema.safeParse({ businessCode: "abc123" }).success, false);
assert.equal(businessSchema.safeParse({ businessCode: "541800" }).success, true);
assert.equal(businessSchema.safeParse({ businessCode: "" }).success, true, "clearing is allowed");

/* Only the two methods a Schedule C offers. */
assert.equal(businessSchema.safeParse({ accountingMethod: "cash" }).success, true);
assert.equal(businessSchema.safeParse({ accountingMethod: "accrual" }).success, true);
assert.equal(businessSchema.safeParse({ accountingMethod: "hybrid" }).success, false);

/* Every field is optional: saving one must not blank the others. */
assert.equal(businessSchema.safeParse({}).success, true);
assert.deepEqual(Object.keys(businessSchema.parse({})), []);

console.log("business: all checks passed");
