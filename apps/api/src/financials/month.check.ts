import { deriveStatus, quotaMetFor, rollForward } from "./month";

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

/* Roll-forward. */
const previous = [
  { name: "Adobe", categoryLine: "software", amountCents: 5999, kind: "recurring", variable: false, color: "#ff6b7a" },
  { name: "Anthropic API", categoryLine: "software", amountCents: 14820, kind: "recurring", variable: true, color: "#ffcf6b" },
  { name: "Client dinner", categoryLine: "meals", amountCents: 8460, kind: "one_off", variable: false, color: null },
];
const next = rollForward(previous, "2026-07");

eq(next.length, 2, "one-off costs do not roll forward");
eq(next[0]!.amountCents, 5999, "a fixed cost carries its amount");
eq(next[1]!.amountCents, null, "a variable cost rolls forward with no amount, so the missing bill shows");
eq(next[0]!.month, "2026-07", "rolled rows belong to the new month");
eq(next[1]!.color, "#ffcf6b", "colour is carried so a category stays the same colour");
eq(rollForward([], "2026-07").length, 0, "an empty previous month rolls nothing");

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

console.log("financials month: all checks passed");
