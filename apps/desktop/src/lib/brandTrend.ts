import type { ClientAnalytics } from "./api";

const DAY = 86_400_000;

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Views per calendar day across all of a brand's accounts, oldest first, one
 * entry for every day of the window including the empty ones. Snapshots are
 * daily buckets (see buildAnalytics in the API), so a day's views are a sum.
 */
export function dailyViews(a: ClientAnalytics, days: number, now = new Date()): number[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * DAY)));
  const byDay = new Map(keys.map((k) => [k, 0]));
  for (const acc of a.accounts) {
    for (const h of acc.history) {
      const k = dayKey(new Date(h.capturedAt));
      if (byDay.has(k)) byDay.set(k, byDay.get(k)! + (h.views ?? 0));
    }
  }
  return keys.map((k) => byDay.get(k)!);
}

/** Percent change, or null when there was nothing before to compare with. */
export function pctChange(current: number, previous: number | null): number | null {
  if (previous == null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
