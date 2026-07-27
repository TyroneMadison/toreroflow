import type { ExpenseCategory } from "@toreroflow/core";

export interface RevenueRow {
  id: string;
  clientId: string;
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
  incurredOn: string | null;
  color: string | null;
  note: string | null;
}

export interface SeriesPoint {
  month: string;
  inCents: number;
  outCents: number;
}

export interface FinancialsMonth {
  month: string;
  categories: ExpenseCategory[];
  revenue: RevenueRow[];
  recurring: ExpenseRow[];
  oneOff: ExpenseRow[];
  /** Twelve months ending at `month`, oldest first. */
  series: SeriesPoint[];
  ytd: { inCents: number; netCents: number };
  /** Years the export selector offers, newest first. */
  years: number[];
  totals: {
    inCents: number;
    recurringOutCents: number;
    oneOffOutCents: number;
    missingBills: number;
  };
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
