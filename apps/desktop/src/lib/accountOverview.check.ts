/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Account Overview's pill, reason line and most-urgent-first order.
 */
import type { OverviewClient } from "./api";
import { byUrgency, reason, status } from "./accountOverview";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const fine: OverviewClient = {
  id: "ok",
  name: "Fine",
  avatarSeed: null,
  avatarUrl: null,
  platforms: [{ platform: "instagram", handle: "fine", status: "connected" }],
  delivery: null,
  lastPostAt: "2026-10-28T00:00:00Z",
  daysQuiet: 0,
  report: { month: "2026-10", label: "Oct 2026", built: true, opened: true, publishedMonth: "2026-10", url: "https://x", stale: false },
  needsReconnect: false,
  insight: { status: "ready", url: null, completedAt: null },
  attention: 0,
};
const noPlan: OverviewClient = { ...fine, id: "warn", insight: null, attention: 3 };
const dropped: OverviewClient = { ...fine, id: "bad", needsReconnect: true, attention: 1000 };
const quiet: OverviewClient = { ...fine, id: "quiet", daysQuiet: 20, attention: 20 };

eq(status(fine).word, "On track", "nothing wrong is on track");
eq(reason(fine), "All 5 steps on track", "on track says so");
eq(status(noPlan).word, "Behind", "a missing plan is behind");
eq(reason(noPlan), "Plan: none yet", "the reason names the step");
eq(status(dropped).word, "Needs you", "a dropped platform needs you");
eq(byUrgency([fine, noPlan, quiet, dropped]).map((c) => c.id), ["bad", "quiet", "warn", "ok"], "needs you, then behind, then on track");

console.log("accountOverview.check ok");
