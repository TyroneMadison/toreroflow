import { recentCompletedWeeks, weekBounds, weekKey, weekLabel, weekStart } from "./weeks";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* Weeks start on Monday. 2026-07-29 is a Wednesday. */
eq(iso(weekStart(new Date(2026, 6, 29))), "2026-07-27", "a Wednesday belongs to Monday's week");
eq(iso(weekStart(new Date(2026, 6, 27))), "2026-07-27", "a Monday is its own week start");

/*
 * Sunday is the trap. getDay() calls it 0, so the naive "subtract getDay() - 1"
 * lands a day in the future and moves every Sunday's videos into the next
 * week's report, where the client cannot see they are missing.
 */
eq(iso(weekStart(new Date(2026, 7, 2))), "2026-07-27", "a Sunday closes the week that began six days earlier");

/* The bounds cover the whole week, ending at the last instant of Sunday. */
{
  const w = weekBounds(new Date(2026, 6, 29));
  eq(iso(w.start), "2026-07-27", "week starts Monday");
  eq(iso(w.end), "2026-08-02", "week ends Sunday");
  eq(w.start.getHours(), 0, "from the first moment of Monday");
  eq(w.end.getHours(), 23, "to the last of Sunday");
  eq(w.end.getMinutes(), 59, "");
  eq(w.end.getMilliseconds(), 999, "so a post at 23:59:59.400 on Sunday is inside the week");
}

/*
 * Only completed weeks. Asked on a Wednesday, the newest week reported is the
 * one that ended on Sunday, never the three days elapsed so far: a partial
 * week understates every number in it and reads as a collapse.
 */
{
  const weeks = recentCompletedWeeks(4, new Date(2026, 6, 29, 14, 0, 0));
  eq(weeks.length, 4, "four weeks asked for, four returned");
  eq(iso(weeks[0]!.start), "2026-07-20", "the newest completed week, not the one in progress");
  eq(iso(weeks[0]!.end), "2026-07-26", "");
  eq(iso(weeks[1]!.start), "2026-07-13", "then the one before it");
  eq(iso(weeks[3]!.start), "2026-06-29", "and back four");
  // Newest first, so the switcher reads recent to older left to right.
  eq(
    weeks.every((w, i) => i === 0 || w.start < weeks[i - 1]!.start),
    true,
    "newest first",
  );
}

/* Asked on a Monday, last week is the one that ended yesterday. */
{
  const weeks = recentCompletedWeeks(1, new Date(2026, 6, 27, 9, 0, 0));
  eq(iso(weeks[0]!.start), "2026-07-20", "on a Monday the last completed week ended yesterday");
  eq(iso(weeks[0]!.end), "2026-07-26", "");
}

/* Weeks never overlap, which is what stops one video being counted twice. */
{
  const weeks = recentCompletedWeeks(6, new Date(2026, 7, 5));
  for (let i = 1; i < weeks.length; i++) {
    eq(
      weeks[i]!.end.getTime() < weeks[i - 1]!.start.getTime(),
      true,
      "consecutive weeks do not overlap",
    );
  }
}

/* A week spanning a month boundary is labelled and keyed by its start. */
{
  const w = weekBounds(new Date(2026, 6, 30));
  eq(weekLabel(w), "Jul 27 - Aug 2", "a week reads across the month it straddles");
  eq(weekKey(w), "2026-07-27", "and keys on the Monday it began");
}

console.log("weeks: all checks passed");
