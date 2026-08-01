import {
  deriveStatus,
  monthlyShareOfAnnual,
  projectRecurring,
  quotaMetFor,
  reconcilePrice,
} from "./month";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/* Paid is the only stored fact and always wins. */
eq(
  deriveStatus({ receivedAt: new Date(), billingMode: "on_fulfilment", quotaMet: false }),
  "paid",
  "a received payment is paid even if the cycle looks unfinished",
);

/* Fulfilment gated: quota decides. */
eq(
  deriveStatus({ receivedAt: null, billingMode: "on_fulfilment", quotaMet: false }),
  "pending",
  "an undelivered cycle is not due however late in the month it is",
);
eq(
  deriveStatus({ receivedAt: null, billingMode: "on_fulfilment", quotaMet: true }),
  "due",
  "delivering the cycle makes it due",
);

/* Calendar: the date decides, delivery is irrelevant. */
eq(
  deriveStatus({ receivedAt: null, billingMode: "calendar", quotaMet: false }),
  "due",
  "a calendar client is due on the day regardless of delivery",
);
eq(
  deriveStatus({ receivedAt: null, billingMode: "calendar", quotaMet: false }),
  "due",
  "a calendar client is never pending, only not yet paid",
);
eq(
  deriveStatus({ receivedAt: null, billingMode: "calendar", quotaMet: true }),
  "due",
  "delivery does not change a calendar client either way",
);

/* Recurring cost projection. */
const previous = [
  { seriesId: "s-adobe", month: "2026-06", name: "Adobe", categoryLine: "software", amountCents: 5999, kind: "recurring", variable: false, color: "#ff6b7a" },
  { seriesId: "s-api", month: "2026-06", name: "Anthropic API", categoryLine: "software", amountCents: 14820, kind: "recurring", variable: true, color: "#ffcf6b" },
  { seriesId: null, month: "2026-06", name: "Client dinner", categoryLine: "meals", amountCents: 8460, kind: "one_off", variable: false, color: null },
];
const next = projectRecurring(previous, "2026-07");

eq(next.length, 2, "one-off costs never project");
eq(next.find((r) => r.seriesId === "s-adobe")!.amountCents, 5999, "a fixed cost carries its amount");
eq(
  next.find((r) => r.seriesId === "s-api")!.amountCents,
  null,
  "a variable cost projects with no amount, so the missing bill shows",
);
eq(next[0]!.month, "2026-07", "projected rows belong to the target month");
eq(next.find((r) => r.seriesId === "s-api")!.color, "#ffcf6b", "colour carries so a category stays the same colour");
eq(projectRecurring([], "2026-07").length, 0, "no history projects nothing");

/*
 * The bug this function exists to kill.
 *
 * The old roll-forward ran exactly once per month, the first time the month
 * was opened. Opening August before July had any costs entered spent that one
 * chance against an empty July and left August permanently empty. Projection
 * is computed fresh every read, so a cost entered late still lands.
 */
eq(
  projectRecurring(previous, "2026-08").length,
  2,
  "a month opened early still fills in once the costs exist",
);

/* Idempotent: a series already in the month is not added a second time. */
eq(
  projectRecurring(previous, "2026-07", ["s-adobe"]).length,
  1,
  "a series already present in the month is left alone",
);
eq(
  projectRecurring(previous, "2026-07", ["s-adobe", "s-api"]).length,
  0,
  "a fully populated month gains nothing on a re-read",
);

/*
 * Removal has to stick. Without an explicit end, projection would read last
 * month's surviving row and helpfully resurrect a cost the operator deleted,
 * which is the exact failure the old one-shot flag was protecting against.
 */
const ended = [
  { seriesId: "s-gone", month: "2026-06", name: "Old SaaS", categoryLine: "software", amountCents: 900, kind: "recurring", variable: false, color: null, endedMonth: "2026-07" },
];
eq(projectRecurring(ended, "2026-07").length, 0, "a cost removed in July does not come back in July");
eq(projectRecurring(ended, "2026-09").length, 0, "and does not come back in any later month either");
eq(
  projectRecurring(ended, "2026-06").length,
  0,
  "the month it was removed from is history and is not re-derived",
);

/* The latest occurrence wins, so a corrected amount carries rather than an old one. */
const corrected = [
  { seriesId: "s-x", month: "2026-05", name: "Hosting", categoryLine: "software", amountCents: 500, kind: "recurring", variable: false, color: null },
  { seriesId: "s-x", month: "2026-06", name: "Hosting", categoryLine: "software", amountCents: 809, kind: "recurring", variable: false, color: null },
];
eq(
  projectRecurring(corrected, "2026-07")[0]!.amountCents,
  809,
  "the most recent amount carries, not the oldest",
);

/* A future month must not be treated as history for an earlier one. */
eq(
  projectRecurring(corrected, "2026-06")[0]!.amountCents,
  500,
  "projecting June reads May, never June itself or July",
);

// A fulfilment client with no targets has nothing countable delivered, so
// the cycle is not met and no invoice is offered. Calendar clients are
// unaffected: their money is owed by the month, not by delivery.
eq(
  quotaMetFor({ quotaShort: null, quotaLong: null, billingMode: "on_fulfilment" }, { short: 9, long: 9 }),
  false,
  "a fulfilment client with no targets is not met even with delivered work",
);
eq(
  quotaMetFor({ quotaShort: null, quotaLong: null, billingMode: "calendar" }, { short: 0, long: 0 }),
  true,
  "a calendar client with no targets is always met",
);
eq(
  quotaMetFor({ quotaShort: 10, quotaLong: null, billingMode: "on_fulfilment" }, { short: 10, long: 0 }),
  true,
  "meeting the short quota counts as met when long is not tracked",
);
eq(
  quotaMetFor({ quotaShort: 10, quotaLong: 2, billingMode: "on_fulfilment" }, { short: 10, long: 1 }),
  false,
  "meeting short but not long does not count as met",
);

/*
 * Annual costs.
 *
 * The rule that carries the money consequence: a yearly subscription must not
 * roll forward. It holds a whole year in one row, so twelve copies would tell
 * the tax export the thing was bought twelve times and inflate the deduction
 * by eleven twelfths of it.
 */
const withAnnual = [
  { seriesId: "s-adobe", month: "2026-07", name: "Adobe", categoryLine: "software", amountCents: 6000, kind: "recurring", variable: false, color: null, cadence: "monthly" },
  { seriesId: "s-domain", month: "2026-07", name: "Domain renewal", categoryLine: "software", amountCents: 120_00, kind: "recurring", variable: false, color: null, cadence: "annual" },
];
const rolled = projectRecurring(withAnnual, "2026-08");
eq(rolled.length, 1, "only the monthly cost carries into the next month");
eq(rolled[0]!.name, "Adobe", "and it is the monthly one");
eq(
  rolled.some((r) => r.cadence === "annual"),
  false,
  "nothing that projects is ever marked annual",
);

// A twelfth of the year, so twelve months add back up to what was actually paid.
eq(monthlyShareOfAnnual([{ amountCents: 120_00 }]), 10_00, "a $120 year is $10 a month");
eq(monthlyShareOfAnnual([]), 0, "no annual costs is no share, not a divide by zero");
eq(
  monthlyShareOfAnnual([{ amountCents: null }, { amountCents: 240_00 }]),
  20_00,
  "an annual bill nobody has entered yet counts as unknown, not as free",
);
// Rounded down, so twelve months can never total more than was really spent.
eq(monthlyShareOfAnnual([{ amountCents: 100 }]), 8, "a rounding remainder is dropped, never invented");

/*
 * Reconciling a month's price against Settings.
 *
 * The live failure, pinned: Caleb's standing price is $850 and his August row
 * said $1,500 because August had been opened a week before the price was
 * corrected. Nothing in the old code ever looked at that row again.
 */
eq(
  reconcilePrice({
    amountCents: 150_000,
    standingPriceCents: 85_000,
    receivedAt: null,
    priceOverridden: false,
  }),
  85_000,
  "a stale seeded amount is corrected to the standing price",
);
eq(
  reconcilePrice({
    amountCents: 85_000,
    standingPriceCents: 85_000,
    receivedAt: null,
    priceOverridden: false,
  }),
  null,
  "a row that already agrees with Settings is left alone",
);

/* The three things that make a row the operator's, not the seeder's. */
eq(
  reconcilePrice({
    amountCents: 50_000,
    standingPriceCents: 85_000,
    receivedAt: null,
    priceOverridden: true,
  }),
  null,
  "a hand-typed amount overrules Settings for that month",
);
eq(
  reconcilePrice({
    amountCents: 150_000,
    standingPriceCents: 85_000,
    receivedAt: new Date("2026-07-28"),
    priceOverridden: false,
  }),
  null,
  "a paid month is never rewritten, because an invoice already went out on it",
);
eq(
  reconcilePrice({
    amountCents: 150_000,
    standingPriceCents: null,
    receivedAt: null,
    priceOverridden: false,
  }),
  null,
  "a client with no standing price is not billed, which is not an error",
);

console.log("financials month: all checks passed");
