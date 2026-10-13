/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The Dashboard's per-day series and its % change against the last period.
 */
import type { ClientAnalytics } from "./api";
import { dailyViews, pctChange } from "./brandTrend";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const now = new Date(2026, 9, 13, 15, 0);
const at = (daysAgo: number, hour = 9) =>
  new Date(2026, 9, 13 - daysAgo, hour).toISOString();
const snap = (daysAgo: number, views: number | null, hour?: number) => ({
  capturedAt: at(daysAgo, hour),
  views,
  reach: null,
  followers: null,
});

const analytics = {
  accounts: [
    { history: [snap(0, 10), snap(2, 5), snap(9, 999)] },
    { history: [snap(0, 1, 23), snap(1, null), snap(2, 7, 0)] },
  ],
} as unknown as ClientAnalytics;

eq(
  dailyViews(analytics, 3, now),
  [12, 0, 11],
  "one entry per day oldest first, accounts summed, nulls as 0, outside the window ignored",
);
eq(dailyViews(analytics, 1, now), [11], "a one-day window is today only");

eq(pctChange(110, 100), 10, "up 10%");
eq(pctChange(90, 100), -10, "down 10%");
eq(pctChange(50, 0), null, "nothing before means no comparison, not infinity");
eq(pctChange(50, null), null, "unknown before means no comparison");

console.log("brandTrend: all checks passed");
