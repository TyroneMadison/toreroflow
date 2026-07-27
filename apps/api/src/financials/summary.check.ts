import assert from "node:assert/strict";
import { buildSeries, monthKeysEnding, ytdTotals } from "./summary";

// Twelve keys ending at the requested month, crossing the year boundary.
const keys = monthKeysEnding("2026-02", 12);
assert.equal(keys.length, 12);
assert.equal(keys[0], "2025-03");
assert.equal(keys[11], "2026-02");

// Months with no rows are zero, not missing; null amounts are excluded.
const series = buildSeries(
  "2026-02",
  [
    { month: "2026-01", amountCents: 150000 },
    { month: "2026-01", amountCents: 50000 },
    { month: "2026-02", amountCents: 150000 },
  ],
  [
    { month: "2026-01", amountCents: 5999 },
    { month: "2026-02", amountCents: null },
    { month: "2026-02", amountCents: 7900 },
  ],
);
assert.equal(series.length, 12);
assert.deepEqual(series[10], { month: "2026-01", inCents: 200000, outCents: 5999 });
assert.deepEqual(series[11], { month: "2026-02", inCents: 150000, outCents: 7900 });
assert.deepEqual(series[0], { month: "2025-03", inCents: 0, outCents: 0 });

// YTD counts only the requested year up to and including the month.
const ytd = ytdTotals(
  "2026-02",
  [
    { month: "2025-12", amountCents: 999999 },
    { month: "2026-01", amountCents: 200000 },
    { month: "2026-02", amountCents: 150000 },
    { month: "2026-03", amountCents: 888888 },
  ],
  [
    { month: "2026-01", amountCents: 5999 },
    { month: "2026-02", amountCents: null },
  ],
);
assert.equal(ytd.inCents, 350000);
assert.equal(ytd.netCents, 350000 - 5999);

console.log("summary: all checks passed");
