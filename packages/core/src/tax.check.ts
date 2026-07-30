import assert from "node:assert/strict";
import { estimateTax, selfEmploymentTax, STATE_TAX, TAX_YEAR } from "./tax";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The property being defended is that a reserve is never quietly too small.
 * Every figure here was worked by hand from the published 2026 numbers first,
 * and the code is checked against that rather than the other way round.
 */

assert.equal(TAX_YEAR, 2026);

/* ---- self employment tax, worked by hand ---- */
{
  // $100,000 profit. 92.35% of it is subject: $92,350.
  // Social Security 12.4% = $11,451.40. Medicare 2.9% = $2,678.15.
  const se = selfEmploymentTax(10_000_000, "single", 0);
  assert.equal(se, 1_412_955, "12.4% + 2.9% of 92,350 is 14,129.55");
}

/* Social Security stops at the wage base; Medicare keeps going. */
{
  // $400,000 profit: earnings 369,400, above the 184,500 base.
  // SS is capped at 184,500 x 12.4% = 22,878.
  // Medicare 369,400 x 2.9% = 10,712.60.
  // Additional 0.9% on (369,400 - 200,000) = 1,524.60.
  const se = selfEmploymentTax(40_000_000, "single", 0);
  assert.equal(se, 2_287_800 + 1_071_260 + 152_460);
}

/* A loss is not a tax. */
assert.equal(selfEmploymentTax(0), 0);
assert.equal(selfEmploymentTax(-500_000), 0);
assert.equal(estimateTax({ netProfitCents: -500_000 }).totalCents, 0);

/* The extra Medicare threshold counts other income, so a salary can trigger it. */
{
  const alone = selfEmploymentTax(5_000_000, "single", 0);
  const withSalary = selfEmploymentTax(5_000_000, "single", 18_000_000);
  assert.equal(withSalary > alone, true, "a salary pushes profit over the 0.9% threshold");
}

/* ---- the whole estimate, worked by hand ---- */
{
  /*
   * $100,000 profit, single, no other income, Florida.
   *   self employment tax        14,129.55
   *   half of it, deducted        7,064.78  -> AGI 92,935.22
   *   standard deduction         16,100.00  -> 76,835.22 before QBI
   *   QBI is capped at 20% of that          -> 15,367.04
   *   taxable                                  61,468.18
   *   federal: 10% of 12,400        1,240.00
   *          + 12% of 38,000        4,560.00
   *          + 22% of 11,068.18     2,435.00
   *                                 8,235.00
   */
  const est = estimateTax({ netProfitCents: 10_000_000, filingStatus: "single", state: "FL" });
  assert.equal(est.selfEmploymentCents, 1_412_955);
  assert.equal(est.halfSelfEmploymentCents, 706_478);
  assert.equal(est.qbiDeductionCents, 1_536_704);
  assert.equal(est.taxableIncomeCents, 6_146_818);
  assert.equal(est.federalIncomeCents, 823_500);
  assert.equal(est.stateIncomeCents, 0, "Florida takes nothing from pass-through profit");
  assert.equal(est.totalCents, 1_412_955 + 823_500);
  assert.equal(est.effectiveRatePct, 22.4);
  // Four payments must never total less than what is owed.
  assert.equal(est.quarterlyCents * 4 >= est.totalCents, true);
}

/* ---- the business's share, not the household's ---- */
{
  /*
   * A spouse's salary must not inflate what the business is told to reserve.
   * It raises the rate the profit is taxed at, which is real, but the figure
   * still has to be the difference the business makes, not the whole bill.
   */
  const noSalary = estimateTax({
    netProfitCents: 8_000_000,
    filingStatus: "married_joint",
    state: "FL",
  });
  const withSalary = estimateTax({
    netProfitCents: 8_000_000,
    otherIncomeCents: 12_000_000,
    filingStatus: "married_joint",
    state: "FL",
  });
  assert.equal(
    withSalary.federalIncomeCents > noSalary.federalIncomeCents,
    true,
    "other income pushes the profit into higher brackets",
  );
  // The household's whole tax on 200,000 would be far more than this.
  assert.equal(
    withSalary.federalIncomeCents < 4_000_000,
    true,
    "but it is still only the tax the business caused",
  );
}

/* No profit means nothing owed, whatever else the household earns. */
{
  const est = estimateTax({
    netProfitCents: 0,
    otherIncomeCents: 15_000_000,
    filingStatus: "single",
    state: "CA",
  });
  assert.equal(est.totalCents, 0);
  assert.equal(est.federalIncomeCents, 0);
  assert.equal(est.stateIncomeCents, 0);
  assert.equal(est.effectiveRatePct, 0);
}

/* ---- states ---- */
{
  // Every state and DC is present, and no rate is negative or absurd.
  const codes = Object.keys(STATE_TAX);
  assert.equal(codes.length, 51, "50 states plus DC");
  for (const code of codes) {
    const s = STATE_TAX[code]!;
    assert.equal(/^[A-Z]{2}$/.test(code), true, `${code} must be a two letter code`);
    assert.equal(s.rate >= 0 && s.rate < 20, true, `${code} rate ${s.rate} is out of range`);
    // A rate of zero is only ever exact: there is no "roughly nothing".
    if (s.rate === 0) assert.equal(s.exact, true, `${code} charges nothing, so it is exact`);
  }
  // The states with no income tax at all.
  for (const code of ["AK", "FL", "NV", "SD", "TN", "TX", "WY", "NH", "WA"]) {
    assert.equal(STATE_TAX[code]!.rate, 0, `${code} takes nothing from pass-through profit`);
  }
  // Graduated states carry a top rate and must not claim to be exact.
  for (const code of ["CA", "NY", "NJ", "MO", "KS"]) {
    assert.equal(STATE_TAX[code]!.exact, false, `${code} is graduated, so its rate is an estimate`);
  }
}

/* A state with tax charges more than one without, on identical profit. */
{
  const fl = estimateTax({ netProfitCents: 10_000_000, state: "FL" });
  const ca = estimateTax({ netProfitCents: 10_000_000, state: "CA" });
  assert.equal(ca.totalCents > fl.totalCents, true);
  assert.equal(ca.federalIncomeCents, fl.federalIncomeCents, "the federal half does not move");
  assert.equal(ca.stateRateExact, false, "California is graduated");
}

/* An unknown state costs nothing rather than guessing at a rate. */
{
  const est = estimateTax({ netProfitCents: 10_000_000, state: "ZZ" });
  assert.equal(est.stateIncomeCents, 0);
  assert.equal(est.stateRatePct, 0);
}

/* An override beats the table and is treated as exact, because it was typed. */
{
  const est = estimateTax({ netProfitCents: 10_000_000, state: "CA", stateRateOverride: 4 });
  assert.equal(est.stateRatePct, 4);
  assert.equal(est.stateRateExact, true);
  // 4% of profit less the deductible half of self employment tax.
  assert.equal(est.stateIncomeCents, Math.round((10_000_000 - est.halfSelfEmploymentCents) * 0.04));
}

/* Zero is a legitimate override: someone may know their state takes nothing. */
{
  const est = estimateTax({ netProfitCents: 10_000_000, state: "CA", stateRateOverride: 0 });
  assert.equal(est.stateIncomeCents, 0);
}

/* ---- monotonic, which is the least surprising property of a tax ---- */
{
  let previousTotal = -1;
  let previousRate = -1;
  for (const profit of [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000]) {
    const est = estimateTax({ netProfitCents: profit, filingStatus: "single", state: "FL" });
    assert.equal(est.totalCents > previousTotal, true, "more profit is never less tax");
    assert.equal(est.effectiveRatePct >= previousRate, true, "and never a lower rate");
    assert.equal(est.totalCents < profit, true, "tax never exceeds the profit it is on");
    previousTotal = est.totalCents;
    previousRate = est.effectiveRatePct;
  }
}

/* Every part adds up to the total, always. */
for (const profit of [0, 1_000_000, 10_000_000, 40_000_000]) {
  for (const state of ["FL", "CA", "PA"]) {
    const e = estimateTax({ netProfitCents: profit, state, filingStatus: "single" });
    assert.equal(
      e.selfEmploymentCents + e.federalIncomeCents + e.stateIncomeCents,
      e.totalCents,
      `${state} at ${profit} must add up`,
    );
    assert.equal(Number.isInteger(e.totalCents), true, "cents are whole numbers");
  }
}

console.log("tax: all checks passed");
