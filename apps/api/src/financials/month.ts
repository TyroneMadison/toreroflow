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
  /** Whether the calendar billing day has passed. */
  billingDayPassed: boolean;
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
  // money whatever was delivered, so it is due and simply not yet paid.
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
