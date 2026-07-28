// Guards the Zernio history windowing: a window over 366 days would be
// rejected by the API, a gap between windows would silently lose posts,
// and an unbounded walk would hammer the provider forever.
import assert from "node:assert/strict";
import { historyWindows, ZernioProvider } from "./zernio";

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

// Guards analyticsHistory's control flow: it must stop walking once a
// window comes back empty, a failure on the very first window must stay
// loud (total outage), and a failure on a later window must keep whatever
// was already fetched rather than throwing away partial results.
type AnalyticsStub = (
  max?: number,
  fromDate?: string,
  toDate?: string,
) => Promise<Array<Record<string, unknown>>>;

{
  // Stop-on-empty: the first window has items, the second is empty, so the
  // walk must stop there and never fetch a third window.
  const provider = new ZernioProvider("test-key");
  const calls: Array<{ fromDate?: string; toDate?: string }> = [];
  const stub: AnalyticsStub = async (_max, fromDate, toDate) => {
    calls.push({ fromDate, toDate });
    return calls.length === 1 ? [{ id: "1" }] : [];
  };
  provider.analytics = stub;

  const result = await provider.analyticsHistory();
  assert.equal(result.length, 1);
  assert.equal(calls.length, 2);
}

{
  // First-window failure: nothing has been fetched yet, so a total outage
  // must throw instead of silently returning an empty history.
  const provider = new ZernioProvider("test-key");
  const stub: AnalyticsStub = async () => {
    throw new Error("zernio outage");
  };
  provider.analytics = stub;

  await assert.rejects(() => provider.analyticsHistory());
}

{
  // Later-window failure: the first window already produced items, so a
  // failure on the second window must return the partial results, not throw.
  const provider = new ZernioProvider("test-key");
  const calls: Array<{ fromDate?: string; toDate?: string }> = [];
  const stub: AnalyticsStub = async (_max, fromDate, toDate) => {
    calls.push({ fromDate, toDate });
    if (calls.length === 1) return [{ id: "1" }, { id: "2" }];
    throw new Error("later window failed");
  };
  provider.analytics = stub;

  const result = await provider.analyticsHistory();
  assert.equal(result.length, 2);
  assert.deepEqual(result, [{ id: "1" }, { id: "2" }]);
}

console.log("zernio.check: all checks passed");
