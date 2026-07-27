import { deriveStatus, rollForward } from "./month";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/* Paid is the only stored fact and always wins. */
eq(
  deriveStatus({ receivedAt: new Date(), billingMode: "on_fulfilment", quotaMet: false, billingDayPassed: false }),
  "paid",
  "a received payment is paid even if the cycle looks unfinished",
);

/* Fulfilment gated: quota decides. */
eq(
  deriveStatus({ receivedAt: null, billingMode: "on_fulfilment", quotaMet: false, billingDayPassed: true }),
  "pending",
  "an undelivered cycle is not due however late in the month it is",
);
eq(
  deriveStatus({ receivedAt: null, billingMode: "on_fulfilment", quotaMet: true, billingDayPassed: false }),
  "due",
  "delivering the cycle makes it due",
);

/* Calendar: the date decides, delivery is irrelevant. */
eq(
  deriveStatus({ receivedAt: null, billingMode: "calendar", quotaMet: false, billingDayPassed: true }),
  "due",
  "a calendar client is due on the day regardless of delivery",
);
eq(
  deriveStatus({ receivedAt: null, billingMode: "calendar", quotaMet: false, billingDayPassed: false }),
  "due",
  "a calendar client is never pending, only not yet paid",
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

console.log("financials month: all checks passed");
