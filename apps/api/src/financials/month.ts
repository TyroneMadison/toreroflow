/**
 * The pure parts of assembling a financial month.
 *
 * Kept out of the route so they can be checked without a database. These two
 * rules carry the money consequences: a wrong status means an invoice is not
 * sent, and a wrong roll-forward means a cost silently vanishes or an
 * unentered bill is counted as free.
 */

export interface StatusInput {
  /** The only stored state. Set means the money arrived. */
  receivedAt: Date | null;
  billingMode: string;
  /** Whether the client's quota for this cycle is met. */
  quotaMet: boolean;
}

/**
 * Paid, pending or due.
 *
 * Derived rather than stored because delivery changes underneath it: a stored
 * "not due" goes stale the moment a video ships, and a stale "not due" is
 * exactly the error that loses a payment.
 */
export function deriveStatus(input: StatusInput): "paid" | "pending" | "due" {
  if (input.receivedAt !== null) return "paid";
  // Only a fulfilment-gated client can be pending. A calendar client owes the
  // money for the month whatever was delivered and whatever the date, so it is
  // due and simply not yet paid. There is deliberately no billing-day gate: a
  // day of the month that never changed what you saw was a field to fill in
  // for nothing.
  if (input.billingMode === "on_fulfilment" && !input.quotaMet) return "pending";
  return "due";
}

export interface RollForwardRow {
  name: string;
  categoryLine: string;
  amountCents: number | null;
  kind: string;
  variable: boolean;
  color: string | null;
  month?: string;
}

/**
 * The recurring costs that carry into a new month.
 *
 * A fixed cost brings its amount. A variable one arrives with no amount, so
 * an unentered bill is visibly missing rather than silently counted as zero.
 * One-off rows are never carried, which is what makes them one-off.
 */
export function rollForward(previous: RollForwardRow[], month: string): RollForwardRow[] {
  return previous
    .filter((r) => r.kind === "recurring")
    .map((r) => ({
      name: r.name,
      categoryLine: r.categoryLine,
      amountCents: r.variable ? null : r.amountCents,
      kind: "recurring",
      variable: r.variable,
      color: r.color,
      month,
    }));
}

export interface QuotaMetInput {
  quotaShort: number | null;
  quotaLong: number | null;
  billingMode: string;
}

/**
 * Whether a client's cycle counts as delivered.
 *
 * With targets, every tracked format must have reached its target. Without
 * targets the answer depends on the billing mode: a calendar client owes by
 * the month so nothing blocks, but a fulfilment client with no targets has
 * nothing countable delivered, and treating that as met would offer an
 * invoice before any work exists.
 */
export function quotaMetFor(
  input: QuotaMetInput,
  delivered: { short: number; long: number },
): boolean {
  const hasTargets = input.quotaShort != null || input.quotaLong != null;
  if (!hasTargets) return input.billingMode !== "on_fulfilment";
  return (
    (input.quotaShort == null || delivered.short >= input.quotaShort) &&
    (input.quotaLong == null || delivered.long >= input.quotaLong)
  );
}
