/**
 * Pure assembly of the twelve-month series and year-to-date totals.
 *
 * Kept out of the route so the money math can be checked without a
 * database. Null expense amounts are bills not yet entered; they are
 * excluded from every sum here and surfaced through missingBills on the
 * month payload instead, so an unknown bill can never read as free.
 */

export interface MonthCents {
  month: string;
  amountCents: number;
}

export interface MonthMaybeCents {
  month: string;
  amountCents: number | null;
}

export interface SeriesPoint {
  month: string;
  inCents: number;
  outCents: number;
}

/** The `count` month keys ending at `end`, oldest first. */
export function monthKeysEnding(end: string, count: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(y!, m! - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function buildSeries(
  end: string,
  revenue: MonthCents[],
  expenses: MonthMaybeCents[],
  count = 12,
): SeriesPoint[] {
  const keys = monthKeysEnding(end, count);
  const inBy = new Map<string, number>();
  for (const r of revenue) inBy.set(r.month, (inBy.get(r.month) ?? 0) + r.amountCents);
  const outBy = new Map<string, number>();
  for (const e of expenses) {
    if (e.amountCents === null) continue;
    outBy.set(e.month, (outBy.get(e.month) ?? 0) + e.amountCents);
  }
  return keys.map((month) => ({
    month,
    inCents: inBy.get(month) ?? 0,
    outCents: outBy.get(month) ?? 0,
  }));
}

/** Totals for the requested month's year, from January up to that month. */
export function ytdTotals(
  month: string,
  revenue: MonthCents[],
  expenses: MonthMaybeCents[],
): { inCents: number; netCents: number } {
  const year = month.slice(0, 4);
  const counted = (m: string) => m.startsWith(`${year}-`) && m <= month;
  let inCents = 0;
  for (const r of revenue) if (counted(r.month)) inCents += r.amountCents;
  let outCents = 0;
  for (const e of expenses) {
    if (e.amountCents !== null && counted(e.month)) outCents += e.amountCents;
  }
  return { inCents, netCents: inCents - outCents };
}

/**
 * The years the export selector offers: the current year down to the
 * earliest month that holds any financial row at all. A backfilled expense
 * in an older year must surface here, or that deduction can never be
 * exported. Future years stay capped at nowYear on purpose: the UI cannot
 * open future months, and the cap keeps the list short.
 */
export function exportYears(nowYear: number, earliestMonths: Array<string | null>): number[] {
  let earliestYear = nowYear;
  for (const m of earliestMonths) {
    if (m === null) continue;
    const y = Number(m.slice(0, 4));
    if (y < earliestYear) earliestYear = y;
  }
  const years: number[] = [];
  for (let y = nowYear; y >= earliestYear; y--) years.push(y);
  return years;
}
