/**
 * What to set aside for taxes.
 *
 * This is an ESTIMATE for a single member LLC that has not elected to be taxed
 * as a corporation, which is the default and what Torerone LLC is. Such an LLC
 * is a disregarded entity: it pays no tax itself, its profit lands on the
 * owner's Schedule C, and the owner pays self employment tax plus income tax on
 * it. Nothing here is tax advice and none of it replaces a CPA.
 *
 * Three rules run through the file:
 *
 *  - **Money is integer cents**, like everywhere else in this app. Tax
 *    arithmetic in floating point dollars is how a total ends up a penny out
 *    and then arguable.
 *  - **The business's share, not the household's.** Federal income tax is
 *    computed twice, once with the business profit and once without, and the
 *    difference is what the business caused. Anything else would tell an
 *    operator to set aside money for tax on a spouse's salary.
 *  - **Where a figure is uncertain, it errs high.** A reserve that is a little
 *    too big is an inconvenience; one that is too small is a bill in April with
 *    nothing behind it.
 *
 * Figures are for tax year 2026 (IRS Rev. Proc. 2025-32).
 */

export const TAX_YEAR = 2026;

export type FilingStatus = "single" | "married_joint" | "head_of_household";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  married_joint: "Married, filing jointly",
  head_of_household: "Head of household",
};

/** 2026 standard deduction, in cents. */
const STANDARD_DEDUCTION_CENTS: Record<FilingStatus, number> = {
  single: 1_610_000,
  married_joint: 3_220_000,
  head_of_household: 2_415_000,
};

/**
 * 2026 ordinary income brackets, in cents.
 *
 * Each entry is [rate, upperBoundOfBracket]. The last bound is Infinity.
 */
const BRACKETS_CENTS: Record<FilingStatus, Array<[number, number]>> = {
  single: [
    [0.1, 1_240_000],
    [0.12, 5_040_000],
    [0.22, 10_570_000],
    [0.24, 20_177_500],
    [0.32, 25_622_500],
    [0.35, 64_060_000],
    [0.37, Number.POSITIVE_INFINITY],
  ],
  married_joint: [
    [0.1, 2_480_000],
    [0.12, 10_080_000],
    [0.22, 21_140_000],
    [0.24, 40_355_000],
    [0.32, 51_245_000],
    [0.35, 76_870_000],
    [0.37, Number.POSITIVE_INFINITY],
  ],
  head_of_household: [
    [0.1, 1_770_000],
    [0.12, 6_745_000],
    [0.22, 10_570_000],
    [0.24, 20_177_500],
    [0.32, 25_620_000],
    [0.35, 64_060_000],
    [0.37, Number.POSITIVE_INFINITY],
  ],
};

/** Social Security stops at this much of earnings; Medicare never stops. */
const SOCIAL_SECURITY_WAGE_BASE_CENTS = 18_450_000;
const SOCIAL_SECURITY_RATE = 0.124;
const MEDICARE_RATE = 0.029;
const ADDITIONAL_MEDICARE_RATE = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLD_CENTS: Record<FilingStatus, number> = {
  single: 20_000_000,
  married_joint: 25_000_000,
  head_of_household: 20_000_000,
};

/**
 * Only 92.35% of profit is subject to self employment tax.
 *
 * That is the employer half of FICA, which an employee would never have had
 * counted as their own income in the first place.
 */
const SE_TAXABLE_FRACTION = 0.9235;

/** Section 199A, the qualified business income deduction. Permanent as of the 2025 act. */
const QBI_RATE = 0.2;

/**
 * A state's tax on business profit that passes through to its owner.
 *
 * `rate` is a percentage. `exact` marks the states where one number is the
 * whole truth: no income tax at all, or a single flat rate. Where a state has
 * graduated brackets this carries its TOP rate and `exact` is false, which
 * deliberately overstates for anyone not in the top bracket. That direction is
 * chosen on purpose for a reserve, and the screen says so rather than implying
 * a precision this does not have.
 *
 * Rates are as published for 2026 and every one of them is editable in
 * Settings, because a table like this goes stale every January and an operator
 * should never be stuck with a number they can see is wrong.
 */
export interface StateTax {
  rate: number;
  exact: boolean;
  note?: string;
}

export const STATE_TAX: Record<string, StateTax> = {
  AL: { rate: 5.0, exact: false },
  AK: { rate: 0, exact: true, note: "No state income tax." },
  AZ: { rate: 2.5, exact: true, note: "Flat rate." },
  AR: { rate: 3.9, exact: false },
  CA: { rate: 13.3, exact: false },
  CO: { rate: 4.4, exact: true, note: "Flat rate." },
  CT: { rate: 6.99, exact: false },
  DE: { rate: 6.6, exact: false },
  DC: { rate: 10.75, exact: false },
  FL: { rate: 0, exact: true, note: "No state income tax on profit that passes through to you." },
  GA: { rate: 5.19, exact: true, note: "Flat rate." },
  HI: { rate: 11.0, exact: false },
  ID: { rate: 5.3, exact: true, note: "Flat rate." },
  IL: { rate: 4.95, exact: true, note: "Flat rate." },
  IN: { rate: 2.95, exact: true, note: "Flat rate." },
  IA: { rate: 3.8, exact: true, note: "Flat rate." },
  KS: { rate: 5.58, exact: false },
  KY: { rate: 3.5, exact: true, note: "Flat rate." },
  LA: { rate: 3.0, exact: true, note: "Flat rate." },
  ME: { rate: 7.15, exact: false },
  MD: { rate: 6.5, exact: false },
  MA: { rate: 9.0, exact: false },
  MI: { rate: 4.25, exact: true, note: "Flat rate." },
  MN: { rate: 9.85, exact: false },
  MS: { rate: 4.0, exact: true, note: "Flat rate." },
  MO: { rate: 4.7, exact: false },
  MT: { rate: 5.65, exact: false },
  NE: { rate: 4.55, exact: false },
  NV: { rate: 0, exact: true, note: "No state income tax." },
  NH: { rate: 0, exact: true, note: "No tax on earned income." },
  NJ: { rate: 10.75, exact: false },
  NM: { rate: 5.9, exact: false },
  NY: { rate: 10.9, exact: false },
  NC: { rate: 3.99, exact: true, note: "Flat rate." },
  ND: { rate: 2.5, exact: false },
  OH: { rate: 2.75, exact: true, note: "Flat rate from 2026." },
  OK: { rate: 4.5, exact: false },
  OR: { rate: 9.9, exact: false },
  PA: { rate: 3.07, exact: true, note: "Flat rate." },
  RI: { rate: 5.99, exact: false },
  SC: { rate: 6.0, exact: false },
  SD: { rate: 0, exact: true, note: "No state income tax." },
  TN: { rate: 0, exact: true, note: "No state income tax." },
  TX: { rate: 0, exact: true, note: "No state income tax." },
  UT: { rate: 4.5, exact: true, note: "Flat rate." },
  VT: { rate: 8.75, exact: false },
  VA: { rate: 5.75, exact: false },
  WA: { rate: 0, exact: true, note: "No tax on ordinary business income." },
  WV: { rate: 4.82, exact: false },
  WI: { rate: 7.65, exact: false },
  WY: { rate: 0, exact: true, note: "No state income tax." },
};

export interface TaxInput {
  /** Business profit for the year so far, revenue minus deductible costs. */
  netProfitCents: number;
  /** Wages and anything else taxed the same way. Zero if there is none. */
  otherIncomeCents?: number;
  filingStatus?: FilingStatus;
  /** Two letter state. Unknown states are treated as no state tax. */
  state?: string;
  /** Overrides the table, as a percentage. Null or undefined uses the table. */
  stateRateOverride?: number | null;
}

export interface TaxEstimate {
  /** What the estimate was run on, echoed back so a screen cannot drift from it. */
  netProfitCents: number;
  selfEmploymentCents: number;
  /** The federal income tax the business caused, not the household's total. */
  federalIncomeCents: number;
  stateIncomeCents: number;
  totalCents: number;
  /** Total as a percentage of profit, for "set aside this much of every dollar". */
  effectiveRatePct: number;
  /** One of four equal payments, rounded up so four of them are never short. */
  quarterlyCents: number;
  /** Half the self employment tax, deducted before income tax. Shown for the CPA. */
  halfSelfEmploymentCents: number;
  qbiDeductionCents: number;
  taxableIncomeCents: number;
  state: string;
  stateRatePct: number;
  /** False when the state rate is a top bracket standing in for a graduated one. */
  stateRateExact: boolean;
}

/** Progressive tax on an amount, in cents. */
function bracketTax(taxableCents: number, status: FilingStatus): number {
  if (taxableCents <= 0) return 0;
  let owed = 0;
  let floor = 0;
  for (const [rate, ceiling] of BRACKETS_CENTS[status]) {
    if (taxableCents <= floor) break;
    const slice = Math.min(taxableCents, ceiling) - floor;
    owed += slice * rate;
    floor = ceiling;
  }
  return Math.round(owed);
}

/**
 * The self employment tax on a year's profit.
 *
 * Social Security stops at the wage base; Medicare does not, and picks up
 * another 0.9% once total earnings pass the threshold. Other income is counted
 * towards that threshold but never towards the Social Security cap, which
 * overstates slightly for someone already paying it through a job. Overstating
 * a reserve is the safe direction.
 */
export function selfEmploymentTax(
  netProfitCents: number,
  filingStatus: FilingStatus = "single",
  otherIncomeCents = 0,
): number {
  if (netProfitCents <= 0) return 0;
  const earnings = netProfitCents * SE_TAXABLE_FRACTION;

  const socialSecurity = Math.min(earnings, SOCIAL_SECURITY_WAGE_BASE_CENTS) * SOCIAL_SECURITY_RATE;
  const medicare = earnings * MEDICARE_RATE;

  const over = earnings + otherIncomeCents - ADDITIONAL_MEDICARE_THRESHOLD_CENTS[filingStatus];
  const additional = over > 0 ? over * ADDITIONAL_MEDICARE_RATE : 0;

  return Math.round(socialSecurity + medicare + additional);
}

/**
 * Everything owed on this year's profit, split into its parts.
 *
 * Federal income tax is the difference between the household's tax with the
 * business and without it, so a spouse's salary never inflates what this says
 * to set aside.
 */
export function estimateTax(input: TaxInput): TaxEstimate {
  const profit = Math.max(0, Math.round(input.netProfitCents));
  const other = Math.max(0, Math.round(input.otherIncomeCents ?? 0));
  const status = input.filingStatus ?? "single";
  const stateCode = (input.state ?? "").toUpperCase();
  const table = STATE_TAX[stateCode];
  const ratePct =
    input.stateRateOverride == null ? (table?.rate ?? 0) : Math.max(0, input.stateRateOverride);
  const rateExact = input.stateRateOverride == null ? (table?.exact ?? true) : true;

  const seTax = selfEmploymentTax(profit, status, other);
  const halfSe = Math.round(seTax / 2);

  // What the business adds to income, after the deductible half of its own
  // self employment tax.
  const businessAgi = Math.max(0, profit - halfSe);

  const standard = STANDARD_DEDUCTION_CENTS[status];

  /*
   * The qualified business income deduction, capped by taxable income.
   *
   * 20% of business income, but never more than 20% of what is actually
   * taxable, which is the cap that binds at ordinary agency profits. Above the
   * phase-in thresholds further limits apply that depend on wages paid and the
   * kind of trade, and are left to a CPA rather than guessed at here.
   */
  const taxableBeforeQbi = Math.max(0, businessAgi + other - standard);
  const qbi = Math.round(Math.min(businessAgi * QBI_RATE, taxableBeforeQbi * QBI_RATE));
  const taxableIncome = Math.max(0, taxableBeforeQbi - qbi);

  // The same household without the business at all, for the difference.
  const taxableWithout = Math.max(0, other - standard);

  const federalIncome = Math.max(
    0,
    bracketTax(taxableIncome, status) - bracketTax(taxableWithout, status),
  );
  const stateIncome = Math.round(businessAgi * (ratePct / 100));

  const total = seTax + federalIncome + stateIncome;

  return {
    netProfitCents: profit,
    selfEmploymentCents: seTax,
    federalIncomeCents: federalIncome,
    stateIncomeCents: stateIncome,
    totalCents: total,
    effectiveRatePct: profit > 0 ? Math.round((total / profit) * 1000) / 10 : 0,
    // Rounded up: four payments that each fall a cent short would leave a
    // balance owing for no reason anyone could see.
    quarterlyCents: Math.ceil(total / 4),
    halfSelfEmploymentCents: halfSe,
    qbiDeductionCents: qbi,
    taxableIncomeCents: taxableIncome,
    state: stateCode,
    stateRatePct: ratePct,
    stateRateExact: rateExact,
  };
}
