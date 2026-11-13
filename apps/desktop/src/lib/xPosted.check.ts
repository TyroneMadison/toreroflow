import { dayKey, isOwnBrand, xPostedLabel } from "./xPosted";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  },
};

assert.equal(isOwnBrand("Torerone"), true);
assert.equal(isOwnBrand(" torerone "), true, "case and spaces");
for (const n of ["Caleb", "Torerone LLC", "", null, undefined]) assert.equal(isOwnBrand(n), false, `client brand ${n}`);

assert.equal(dayKey(new Date(2026, 9, 28, 23, 59)), "2026-10-28", "late evening stays on the local day");
assert.equal(dayKey(new Date(2026, 0, 5)), "2026-01-05", "zero padded");
assert.equal(xPostedLabel(new Date(2026, 9, 28)), "Posted to X on Wed Oct 28");

console.log("xPosted.check: ok");
