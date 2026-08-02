import { choosePlacement } from "../components/GlassDateTime";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 *
 * The bug this exists to stop: on a laptop the schedule modal put the date
 * trigger low in a short window, the panel opened downward because it could
 * not fit above either, and the last two weeks of the month were off the
 * bottom edge with no way to scroll to them.
 */

/* Plenty of room below: open downward, which is what a picker should do. */
{
  const p = choosePlacement(100, 140, 1080);
  eq(p.up, false, "a tall window opens the panel downward");
  eq(p.maxHeight >= 330, true, "and gives it at least a full panel of room");
}

/* Not enough below, plenty above: flip up. This much already worked. */
{
  const p = choosePlacement(700, 740, 900);
  eq(p.up, true, "a trigger near the bottom opens upward");
}

/*
 * The laptop case, and the actual bug. A short window where neither side fits
 * a whole panel. The old rule required room above before flipping, so it fell
 * through to downward and clipped. The roomier side has to win.
 */
{
  // 600px window, trigger at 380-420: 168px below, 368px above. Neither fits
  // a 330px panel plus its gap, but above is more than twice below.
  const p = choosePlacement(380, 420, 600);
  eq(p.up, true, "with neither side fitting, the roomier side wins");
  eq(p.maxHeight, 368, "and the panel is told exactly how much room it has");
}

/* The mirror of it: more room below than above, still neither fitting. */
{
  const p = choosePlacement(120, 160, 500);
  eq(p.up, false, "more room below than above keeps it downward");
  eq(p.maxHeight, 328, "clamped to what is actually there");
}

/*
 * A panel is always given a usable height, even jammed against an edge, so it
 * scrolls rather than rendering as an unreadable sliver.
 */
{
  const p = choosePlacement(8, 48, 200);
  eq(p.maxHeight >= 220, true, "a cramped trigger still gets a scrollable panel");
}

/* The height returned is never negative, whatever the geometry. */
for (const [top, bottom, h] of [
  [0, 40, 40],
  [900, 940, 300],
  [-50, -10, 600],
] as Array<[number, number, number]>) {
  const p = choosePlacement(top, bottom, h);
  eq(p.maxHeight > 0, true, `a panel always has positive height (${top},${bottom},${h})`);
}

console.log("date placement: all checks passed");
