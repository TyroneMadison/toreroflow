/**
 * Reporting weeks.
 *
 * A client report has always covered a calendar month. A week is the same
 * question asked at a tempo you can still act on: a month-end report tells you
 * what happened, a weekly one tells you in time to change next week's shoot.
 *
 * Weeks run Monday to Sunday, which is what "last week" means to everyone who
 * is not a spreadsheet, and only completed weeks are reported. A week that is
 * still running would show a Tuesday's three videos as the whole week and read
 * as a collapse.
 */

export interface Period {
  start: Date;
  end: Date;
}

/** Midnight local time on the Monday of the week containing `d`. */
export function weekStart(d: Date): Date {
  const day = d.getDay(); // 0 is Sunday
  // Sunday belongs to the week that began six days earlier, not the one
  // starting tomorrow. Getting this backwards moves every Sunday's videos into
  // the following week's report.
  const backToMonday = day === 0 ? 6 : day - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - backToMonday, 0, 0, 0, 0);
}

/** The Monday-to-Sunday week containing `d`, as a full period. */
export function weekBounds(d: Date): Period {
  const start = weekStart(d);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 6,
    23,
    59,
    59,
    999,
  );
  return { start, end };
}

/**
 * The last `count` completed weeks, newest first.
 *
 * "Completed" means it ended before now, so the week in progress is never
 * included: a report covering three days of a seven day week understates
 * everything in it and there is no way for the reader to tell.
 */
export function recentCompletedWeeks(count: number, now = new Date()): Period[] {
  const out: Period[] = [];
  // The Monday of this week; the week before it is the newest completed one.
  const thisMonday = weekStart(now);
  for (let back = 1; back <= count; back++) {
    const d = new Date(
      thisMonday.getFullYear(),
      thisMonday.getMonth(),
      thisMonday.getDate() - back * 7,
    );
    out.push(weekBounds(d));
  }
  return out;
}

/** "28 Jul - 3 Aug", the label a client reads on the switcher. */
export function weekLabel(period: Period): string {
  const day = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day(period.start)} - ${day(period.end)}`;
}

/** Sortable key for a week: the start date as YYYY-MM-DD. */
export function weekKey(period: Period): string {
  const s = period.start;
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
}
