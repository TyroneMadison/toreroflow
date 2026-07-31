/**
 * The yearly reminder to file the LLC's annual paperwork with the State.
 *
 * This is the one deadline in the business that nothing else in the app knows
 * about. Every other date here comes from something the operator did: a post
 * went out, a client paid, a bill landed. The State's filing date comes from
 * nowhere, arrives once a year, and costs real money in penalties and, in some
 * states, administrative dissolution if it is missed.
 *
 * So it escalates rather than firing once. A single reminder on the 1st of
 * April is a reminder you dismiss on the 1st of April and then forget for
 * thirty days.
 */

/** The State's deadline. Month is 1-based here because a date this important should read like one. */
export const FILING_MONTH = 5;
export const FILING_DAY = 1;

/**
 * When to speak up, as [month, day].
 *
 * Four warnings and then the day itself. They tighten as the date approaches
 * because a month out is information and a day out is urgent, and a reminder
 * that sounds the same at both distances teaches you to ignore the early one.
 */
export const FILING_REMINDER_DAYS: Array<[number, number]> = [
  [4, 1],
  [4, 10],
  [4, 15],
  [4, 20],
  [5, 1],
];

export interface FilingReminderInput {
  /** The day being evaluated, in the operator's own timezone. */
  today: Date;
  /**
   * Whether the operator has told the app enough about their tax situation
   * for this reminder to be about them rather than a guess.
   */
  taxDetailsSet: boolean;
  /** Whether a bank is linked. Together these mean the app is really in use. */
  bankConnected: boolean;
}

export interface FilingReminder {
  /** Stable across the year so a repeat updates one row rather than stacking. */
  key: string;
  severity: "warning" | "error";
  message: string;
  detail: string;
  daysLeft: number;
}

/** Local calendar parts, so a UTC clock cannot move the date by a day. */
function parts(d: Date): { year: number; month: number; day: number } {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** Whole days from `today` to this year's filing date, negative once it has passed. */
export function daysUntilFiling(today: Date): number {
  const { year } = parts(today);
  const start = new Date(year, today.getMonth(), today.getDate());
  const deadline = new Date(year, FILING_MONTH - 1, FILING_DAY);
  return Math.round((deadline.getTime() - start.getTime()) / 86_400_000);
}

/**
 * The reminder to raise today, or null on a day that is not one of the five.
 *
 * Null is not "nothing to worry about": it is "nothing new to say". A reminder
 * already raised stays up until the operator dismisses it, so the quiet days
 * between escalations are quiet on purpose.
 *
 * The gate is deliberate. A brand new operator who has entered nothing does
 * not need to be told about a filing deadline for a business the app knows
 * nothing about, and being nagged on day one is how a useful reminder gets
 * trained into noise. Once the tax details and a bank are in, the app knows
 * enough for the date to be real.
 */
export function filingReminderFor(input: FilingReminderInput): FilingReminder | null {
  if (!input.taxDetailsSet || !input.bankConnected) return null;

  const { year, month, day } = parts(input.today);
  const isReminderDay = FILING_REMINDER_DAYS.some(([m, d]) => m === month && d === day);
  if (!isReminderDay) return null;

  return buildReminder(year, daysUntilFiling(input.today));
}

/**
 * The reminder text for a given distance from the deadline.
 *
 * Separate from the schedule so it can also be raised out of band, which is
 * what an operator asking for it today needs.
 */
export function buildReminder(year: number, daysLeft: number): FilingReminder {
  const onTheDay = daysLeft <= 0;
  const soon = daysLeft <= 11;
  return {
    key: `llc_annual_filing:${year}`,
    severity: soon ? "error" : "warning",
    message: onTheDay
      ? `Your LLC's annual State filing is due today, ${monthDay()}.`
      : `Your LLC's annual State filing is due ${monthDay()}, ${daysLeft} day${daysLeft === 1 ? "" : "s"} away.`,
    detail: onTheDay
      ? "File it with your State today. Missing it means late penalties and, in some states, the LLC being administratively dissolved."
      : "File it with your State before the deadline. Missing it means late penalties and, in some states, the LLC being administratively dissolved.",
    daysLeft,
  };
}

function monthDay(): string {
  return new Date(2000, FILING_MONTH - 1, FILING_DAY).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}
