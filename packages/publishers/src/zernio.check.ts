// Guards the Zernio history windowing: a window over 366 days would be
// rejected by the API, a gap between windows would silently lose posts,
// and an unbounded walk would hammer the provider forever.
import assert from "node:assert/strict";
import { historyWindows } from "./zernio";

{
  const today = new Date(Date.UTC(2026, 6, 28)); // 2026-07-28
  const w = historyWindows(today);

  assert.equal(w.length, 10); // default cap
  assert.deepEqual(w[0], { fromDate: "2025-07-28", toDate: "2026-07-28" });

  // Contiguous: each window ends the day before the newer one starts.
  assert.equal(w[1].toDate, "2025-07-27");
  assert.equal(w[1].fromDate, "2024-07-27");

  const DAY = 86_400_000;
  for (const win of w) {
    const from = new Date(`${win.fromDate}T00:00:00.000Z`).getTime();
    const to = new Date(`${win.toDate}T00:00:00.000Z`).getTime();
    const inclusiveDays = (to - from) / DAY + 1;
    assert.ok(
      inclusiveDays <= 366,
      `window ${win.fromDate}..${win.toDate} spans ${inclusiveDays} days`,
    );
    assert.ok(from < to, "window must run forwards");
  }

  // Newest first, walking backwards.
  assert.ok(w[0].toDate > w[1].toDate);

  // Cap honored.
  assert.equal(historyWindows(today, 3).length, 3);
}

console.log("zernio.check: all checks passed");
