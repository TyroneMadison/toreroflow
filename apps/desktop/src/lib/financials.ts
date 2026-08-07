import type { ExpenseCategory } from "@toreroflow/core";

export interface RevenueRow {
  id: string;
  /** Null for hand-entered income: a paycheck transfer, a refund. */
  clientId: string | null;
  /** True when the row was typed in rather than billed to a client. */
  manual: boolean;
  clientName: string;
  avatarUrl: string | null;
  avatarSeed: string | null;
  amountCents: number;
  color: string | null;
  note: string | null;
  receivedAt: string | null;
  status: "paid" | "pending" | "due";
  billingMode: "calendar" | "on_fulfilment";
  quotaMet: boolean;
  /** Null when the client tracks no quota. */
  quotaDelivered: number | null;
  quotaTarget: number | null;
}

export interface ExpenseRow {
  id: string;
  name: string;
  categoryLine: string;
  /** Null means the bill is not known yet, which is not zero. */
  amountCents: number | null;
  month: string;
  kind: "recurring" | "one_off";
  variable: boolean;
  /** monthly | annual. An annual cost holds its whole yearly figure. */
  cadence: "monthly" | "annual";
  /** Day of the month a recurring bill lands. Null when unknown. */
  dueDay: number | null;
  incurredOn: string | null;
  color: string | null;
  note: string | null;
}

/** One month of a year's worth of expenses, from /financials/expenses/by-month. */
export interface ExpenseMonth {
  month: string;
  rows: ExpenseRow[];
  totalCents: number;
  missingBills: number;
}

export interface ExpenseYear {
  year: number;
  kind: "recurring" | "one_off";
  months: ExpenseMonth[];
  totalCents: number;
}

export interface SeriesPoint {
  month: string;
  inCents: number;
  outCents: number;
}

export interface FinancialsMonth {
  month: string;
  /**
   * What is sitting in the bank as of the last pull, over the accounts
   * counted in cash flow. Null when no bank is connected, which is not $0.
   */
  bank: { totalCents: number; asOf: string | null } | null;
  categories: ExpenseCategory[];
  revenue: RevenueRow[];
  recurring: ExpenseRow[];
  oneOff: ExpenseRow[];
  /** Every yearly cost in this month's year, wherever in the year it is charged. */
  annual: ExpenseRow[];
  /** Twelve months ending at `month`, oldest first. */
  series: SeriesPoint[];
  ytd: { inCents: number; netCents: number };
  /** Years the export selector offers, newest first. */
  years: number[];
  totals: {
    inCents: number;
    recurringOutCents: number;
    oneOffOutCents: number;
    /** A twelfth of the year's annual costs, counted in every month. */
    annualShareCents: number;
    /** The full yearly figure those annual costs add up to. */
    annualYearCents: number;
    missingBills: number;
  };
}

/**
 * A typed dollar amount as cents.
 *
 * Three outcomes, and the caller has to tell them apart: a number is the
 * amount, null is a deliberately blank bill (which is not zero, because an
 * unentered cost counted as free overstates profit), and undefined is
 * nonsense the caller should refuse rather than store.
 */
export function dollarsToCents(raw: string): number | null | undefined {
  if (raw.trim() === "") return null;
  const dollars = Number.parseFloat(raw);
  if (!Number.isFinite(dollars) || dollars < 0) return undefined;
  return Math.round(dollars * 100);
}

/** Months of a year as pickable options, oldest first. */
export function monthsOfYear(year: number): Array<{ value: string; label: string }> {
  return Array.from({ length: 12 }, (_, i) => {
    const value = `${year}-${String(i + 1).padStart(2, "0")}`;
    return {
      value,
      label: new Date(year, i, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    };
  });
}

/**
 * "the 3rd", "the 21st". Written out because "3" alone beside a category
 * reads as a quantity rather than a date.
 */
export function ordinalDay(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `the ${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
  return `the ${day}${suffix}`;
}

/** The five colours a row may take. Matches the design tokens. */
export const FINANCE_COLORS = ["#57d6a0", "#4ea8ff", "#8b7bff", "#ffcf6b", "#ff6b7a"] as const;

/** Stable fallback so a chart is never grey before anything is picked. */
export function colorFor(color: string | null, index: number): string {
  return color ?? FINANCE_COLORS[index % FINANCE_COLORS.length]!;
}

/**
 * Donut arcs for an SVG circle of circumference 100.
 *
 * The first arc starts at 12 o'clock (offset 25 in SVG dash space) and each
 * following arc starts where the previous ended. A zero total returns no
 * segments so the chart shows only the track ring, never NaN.
 */
export function donutSegments(
  parts: Array<{ cents: number; color: string }>,
): Array<{ color: string; pct: number; dasharray: string; dashoffset: number }> {
  const total = parts.reduce((a, p) => a + p.cents, 0);
  if (total <= 0) return [];
  let consumed = 0;
  return parts
    .filter((p) => p.cents > 0)
    .map((p) => {
      const pct = (p.cents / total) * 100;
      const seg = {
        color: p.color,
        pct,
        dasharray: `${pct.toFixed(2)} ${(100 - pct).toFixed(2)}`,
        dashoffset: Number((25 - consumed).toFixed(2)),
      };
      consumed += pct;
      return seg;
    });
}

/**
 * A sparkline path pair for an SVG viewBox of the given size.
 *
 * `line` is the stroke, `area` the same path closed along the bottom for the
 * gradient fill. Values map linearly with a small top and bottom margin; a
 * flat series (all equal, including all zero) draws along the baseline.
 */
export function sparkPath(
  values: number[],
  width: number,
  height: number,
): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const top = 6;
  const bottom = height - 6;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const y = span === 0 ? bottom : bottom - ((v - min) / span) * (bottom - top);
    return `${(i * step).toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return { line, area };
}
