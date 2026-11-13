import assert from "node:assert/strict";
import { addLocalDays, localDayNumber, planResume } from "./pauseShift";

const NY = "America/New_York";
const ny = (s: string) => new Date(s); // ISO strings below carry their own offset
const iso = (d: Date) => d.toISOString();

// Spec example: posts Oct 30 to Nov 16 (EDT then EST), paused, resumed Nov 20 at 08:00.
const held = [
  { id: "a", scheduledAt: ny("2026-10-30T10:00:00-04:00") },
  { id: "b", scheduledAt: ny("2026-10-31T18:30:00-04:00") },
  { id: "c", scheduledAt: ny("2026-11-16T09:00:00-05:00") },
];
const plan = planResume(held, ny("2026-11-20T08:00:00-05:00"), NY);
assert.equal(plan.delta, 21);
assert.deepEqual(
  plan.posts.map((p) => iso(p.scheduledAt)),
  [
    iso(ny("2026-11-20T10:00:00-05:00")), // same 10:00 wall time across the DST end
    iso(ny("2026-11-21T18:30:00-05:00")), // spacing kept: one day after the first
    iso(ny("2026-12-07T09:00:00-05:00")),
  ],
);
assert.ok(plan.posts.every((p) => p.moved));

// Past slot on the resume day: 07:00 has passed at 08:00, so it goes to the next day; 10:00 stays.
const past = planResume(
  [
    { id: "early", scheduledAt: ny("2026-11-02T07:00:00-05:00") },
    { id: "late", scheduledAt: ny("2026-11-02T10:00:00-05:00") },
  ],
  ny("2026-11-05T08:00:00-05:00"),
  NY,
);
assert.equal(past.delta, 3);
assert.equal(iso(past.posts[0]!.scheduledAt), iso(ny("2026-11-06T07:00:00-05:00")));
assert.equal(iso(past.posts[1]!.scheduledAt), iso(ny("2026-11-05T10:00:00-05:00")));

// delta <= 0: resumed before the earliest post's day, nothing moves.
const early = planResume(held, ny("2026-10-29T12:00:00-04:00"), NY);
assert.equal(early.delta, -1);
assert.ok(early.posts.every((p) => !p.moved));
assert.deepEqual(early.posts.map((p) => iso(p.scheduledAt)), held.map((p) => iso(p.scheduledAt)));

// delta 0, resumed later the same day: only the slot already gone moves, by one day.
const same = planResume(held, ny("2026-10-30T11:00:00-04:00"), NY);
assert.equal(same.delta, 0);
assert.equal(iso(same.posts[0]!.scheduledAt), iso(ny("2026-10-31T10:00:00-04:00")));
assert.deepEqual(same.posts.slice(1).map((p) => p.moved), [false, false]);

// DST start (2027-03-14 02:00): 01:30 is still EST, noon is EDT, 23 hours after the day before.
const spring = addLocalDays(ny("2027-03-13T01:30:00-05:00"), 1, NY);
assert.equal(iso(spring), iso(ny("2027-03-14T01:30:00-05:00")));
const springNoon = addLocalDays(ny("2027-03-13T12:00:00-05:00"), 1, NY);
assert.equal(iso(springNoon), iso(ny("2027-03-14T12:00:00-04:00")));
// Local day, not UTC day: 23:30 EDT is already the next day in UTC.
assert.equal(
  localDayNumber(ny("2026-10-30T23:30:00-04:00"), NY) - localDayNumber(ny("2026-10-30T00:10:00-04:00"), NY),
  0,
);

assert.deepEqual(planResume([], new Date(), NY), { delta: 0, posts: [] });
console.log("pauseShift.check: ok");
