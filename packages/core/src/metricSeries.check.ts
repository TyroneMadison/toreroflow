import assert from "node:assert/strict";
import { seriesSummary } from "./metricSeries";

const rows = [
  { capturedOn: "2026-08-02", views: 100 },
  { capturedOn: "2026-08-04", views: 260 },
  { capturedOn: "2026-08-06", views: 310 },
];

/* ---- the delta ---- */

const s = seriesSummary(rows, "2026-08-01", "2026-08-01", "2026-08-31");
assert.equal(s.added, 210, "last captured day minus first, 310 - 100");
assert.equal(s.points.length, 3, "every captured day inside the window is a point");

/*
 * Fewer than two days is not a trend. One point cannot produce a delta, and
 * drawing a line through it would suggest a measurement that does not exist.
 */
assert.equal(seriesSummary([rows[0]!], "2026-08-01", "2026-08-01", "2026-08-31").added, null);
assert.equal(seriesSummary([], "2026-08-01", "2026-08-01", "2026-08-31").added, null);

/* ---- the window ---- */

const clipped = seriesSummary(rows, "2026-08-01", "2026-08-03", "2026-08-31");
assert.equal(clipped.added, 50, "only days inside the window count, 310 - 260");
assert.equal(clipped.points.length, 2, "the 08-02 row is outside the window");

/*
 * Both bounds are inclusive, pinned with rows sitting exactly on them. Nothing
 * in the fixture above touches an edge, so a regression to exclusive bounds
 * would pass every other assertion in this file while silently dropping the
 * first and last captured day of every report window.
 */
const edge = [
  { capturedOn: "2026-08-03", views: 100 },
  { capturedOn: "2026-08-05", views: 180 },
  { capturedOn: "2026-08-07", views: 260 },
];
const inclusive = seriesSummary(edge, "2026-08-01", "2026-08-03", "2026-08-07");
assert.equal(inclusive.points.length, 3, "a row captured on `from` or on `to` is inside the window");
assert.equal(inclusive.added, 160, "260 - 100, so neither edge row was dropped from the delta");

/*
 * The honesty rule. Daily capture began after most videos were published, so
 * for those the delta is views since we started watching, not views since it
 * went up. The flag drives a different label, so the number is never read as
 * lifetime growth.
 */
assert.equal(
  seriesSummary(rows, "2026-07-01", "2026-08-01", "2026-08-31").sinceTracking,
  true,
  "published before the first captured day, so this is growth since tracking began",
);
assert.equal(
  seriesSummary(rows, "2026-08-02", "2026-08-01", "2026-08-31").sinceTracking,
  false,
  "captured from the day it was published, so the delta is the real lifetime growth",
);

/* ---- ordering is not assumed ---- */

const shuffled = [rows[2]!, rows[0]!, rows[1]!];
assert.equal(
  seriesSummary(shuffled, "2026-08-01", "2026-08-01", "2026-08-31").added,
  210,
  "rows arrive in whatever order the query returned them",
);

console.log("metricSeries.check.ts: ok");
