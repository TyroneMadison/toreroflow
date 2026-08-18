/**
 * One answer to "may a post be scheduled for this moment".
 *
 * There are three doors into a scheduled time (the schedule modal, the detail
 * modal's picker, and dragging a card across the calendar) and none of them
 * checked. A time in the past is not a harmless mistake: the publish worker
 * runs a job whose moment has passed as soon as it is queued, so scheduling a
 * client's video for yesterday publishes it immediately, which is the one
 * outcome nobody can undo.
 *
 * The rule lives here rather than in each route because a guard that only
 * covers the door somebody remembered is the same bug with fewer entrances.
 */

/**
 * How far into the past a time may still be accepted.
 *
 * Not zero, and this is the whole subtlety. "Post now" sends the instant the
 * operator pressed the button, which is already behind by the time the request
 * lands, so a strict future test would reject the app's own publish button.
 * Clock skew between a laptop and the server spends the rest.
 *
 * A minute, matching the window the publish worker already uses in the other
 * direction: it refuses a job more than 60 seconds EARLY. The two together
 * mean the app and the worker disagree about "now" by at most the same amount.
 */
export const SCHEDULE_GRACE_MS = 60_000;

/**
 * Null when the time is allowed, otherwise the sentence to show.
 *
 * Returns the message rather than throwing so the API can answer 400 with it
 * and the app can print the same words next to the picker, instead of the two
 * drifting into different explanations of one rule.
 */
export function scheduleTimeError(when: Date, now: Date = new Date()): string | null {
  if (Number.isNaN(when.getTime())) return "That is not a valid date and time.";
  if (when.getTime() >= now.getTime() - SCHEDULE_GRACE_MS) return null;
  return "That time has already passed. Pick a time from now on.";
}

/** True when this moment may be scheduled. The boolean form, for UI gating. */
export function isSchedulable(when: Date, now: Date = new Date()): boolean {
  return scheduleTimeError(when, now) === null;
}

/**
 * The earliest moment still worth offering, as a floor for a picker.
 *
 * The grace is deliberately NOT subtracted here. It exists to forgive a
 * request that was already in flight, not to offer a past minute as a choice:
 * a picker that lets you select 59 seconds ago is showing an option that reads
 * as scheduling and behaves as publishing.
 */
export function scheduleFloor(now: Date = new Date()): Date {
  return new Date(now.getTime());
}
