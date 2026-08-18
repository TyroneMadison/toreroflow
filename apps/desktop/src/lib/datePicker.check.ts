/*
 * The gating arithmetic inside GlassDateTime, extracted here so it is checked
 * rather than eyeballed. The old floor was setHours(0,0,0,0) on minDate, which
 * disabled past DAYS and offered every past HOUR of today: at 4pm you could
 * still pick 9am, and the worker publishes a past-dated job the moment it is
 * queued. The boundaries below are exactly where that went wrong.
 */
import assert from "node:assert/strict";

/** Mirrors the predicates in GlassDateTime. */
const dayIsPast = (d: Date, floor: Date) => {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end < floor;
};
const hourIsPast = (selected: Date, h24: number, floor: Date) => {
  const end = new Date(selected);
  end.setHours(h24, 59, 59, 999);
  return end < floor;
};
const minuteIsPast = (selected: Date, m: number, floor: Date) => {
  const at = new Date(selected);
  at.setMinutes(m, 59, 999);
  return at < floor;
};

// It is 2:30pm on 18 August.
const floor = new Date(2026, 7, 18, 14, 30, 0, 0);
const today = new Date(2026, 7, 18, 14, 30, 0, 0);

// Days: yesterday is gone, today survives because its evening has not.
assert.equal(dayIsPast(new Date(2026, 7, 17), floor), true, "yesterday");
assert.equal(dayIsPast(new Date(2026, 7, 18), floor), false, "today is not over");
assert.equal(dayIsPast(new Date(2026, 7, 19), floor), false, "tomorrow");

// Hours on today: this is the case the old code got wrong.
assert.equal(hourIsPast(today, 9, floor), true, "9am has gone");
assert.equal(hourIsPast(today, 13, floor), true, "1pm has gone");
assert.equal(hourIsPast(today, 14, floor), false, "the current hour still has minutes left");
assert.equal(hourIsPast(today, 15, floor), false, "3pm is fine");
assert.equal(hourIsPast(today, 23, floor), false, "tonight is fine");

// Minutes inside the current hour: 29 is gone, 30 is now, 31 is ahead.
assert.equal(minuteIsPast(today, 29, floor), true, "the minute just gone");
assert.equal(minuteIsPast(today, 30, floor), false, "this minute still counts");
assert.equal(minuteIsPast(today, 31, floor), false, "the next minute");

// On a future day nothing is gated, or the picker would refuse a valid choice.
const tomorrow = new Date(2026, 7, 19, 14, 30);
for (const h of [0, 6, 9, 13, 23]) {
  assert.equal(hourIsPast(tomorrow, h, floor), false, `tomorrow ${h}:00 is selectable`);
}
assert.equal(minuteIsPast(tomorrow, 0, floor), false, "and every minute of it");

// A whole meridiem goes only when all six of its hours have.
const amGone = Array.from({ length: 12 }, (_, i) => i % 12).every((h) => hourIsPast(today, h, floor));
const pmGone = Array.from({ length: 12 }, (_, i) => (i % 12) + 12).every((h) => hourIsPast(today, h, floor));
assert.equal(amGone, true, "at 2:30pm the whole morning has gone");
assert.equal(pmGone, false, "the afternoon has not");

// Just before midnight, the day itself is still not past: 23:59 is schedulable.
const late = new Date(2026, 7, 18, 23, 59, 0, 0);
assert.equal(dayIsPast(new Date(2026, 7, 18), late), false, "the last minute still counts");
assert.equal(minuteIsPast(late, 59, late), false);
assert.equal(minuteIsPast(late, 58, late), true);

console.log("datePicker.check: all checks passed");
