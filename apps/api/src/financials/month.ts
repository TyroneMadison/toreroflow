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

export interface SeriesRow {
  /** Stable identity of one recurring cost across every month it appears in. */
  seriesId: string | null;
  /** The month this particular occurrence sits in. */
  month: string;
  name: string;
  categoryLine: string;
  amountCents: number | null;
  kind: string;
  variable: boolean;
  color: string | null;
  cadence?: string;
  dueDay?: number | null;
  note?: string | null;
  /**
   * Set when the operator removed the cost. From this month on it stops
   * appearing; earlier months keep theirs, because they really were paid.
   */
  endedMonth?: string | null;
}

/**
 * The recurring costs that belong in `month`.
 *
 * A subscription is a standing thing, not a copy that happens to get made the
 * first time somebody opens a month. That distinction is the whole bug this
 * replaced: the old version copied last month's rows exactly once, gated on a
 * "has this month been opened" flag, so glancing at a future month spent its
 * only chance and left it permanently empty. August was opened nine minutes
 * before July here, and lost every recurring cost as a result.
 *
 * So this is a projection rather than a copy, and it is safe to run on every
 * read: a series already present in the month is left alone, which makes it
 * idempotent, and one that is missing is filled in, which makes it
 * self-healing when a cost is added to a month that was already visited.
 *
 * A fixed cost brings its amount. A variable one arrives with no amount, so an
 * unentered bill is visibly missing rather than silently counted as zero.
 * One-off rows never project, which is what makes them one-off.
 *
 * Annual costs never project either, for a different reason: the row holds a
 * whole year's figure and the money leaves once. Repeating it in all twelve
 * months would tell the tax export the subscription was bought twelve times.
 * The monthly share is worked out separately, by monthlyShareOfAnnual.
 */
export function projectRecurring(
  history: SeriesRow[],
  month: string,
  alreadyPresent: Iterable<string> = [],
): SeriesRow[] {
  const present = new Set(alreadyPresent);

  // The most recent occurrence of each series before the target month. Latest
  // wins so an amount corrected in June carries into July, rather than July
  // resurrecting whatever the cost was in January.
  const latest = new Map<string, SeriesRow>();
  for (const row of history) {
    if (row.seriesId === null) continue;
    if (row.kind !== "recurring") continue;
    if ((row.cadence ?? "monthly") === "annual") continue;
    if (row.month >= month) continue;
    const seen = latest.get(row.seriesId);
    if (!seen || row.month > seen.month) latest.set(row.seriesId, row);
  }

  const out: SeriesRow[] = [];
  for (const [seriesId, row] of latest) {
    if (present.has(seriesId)) continue;
    // Ended in or before this month means the operator removed it. Comparing
    // the keys as strings sorts correctly because both are "YYYY-MM".
    if (row.endedMonth != null && month >= row.endedMonth) continue;
    out.push({
      seriesId,
      month,
      name: row.name,
      categoryLine: row.categoryLine,
      amountCents: row.variable ? null : row.amountCents,
      kind: "recurring",
      variable: row.variable,
      color: row.color,
      cadence: "monthly",
      dueDay: row.dueDay ?? null,
      note: row.note ?? null,
      endedMonth: null,
    });
  }
  return out;
}

/**
 * What a year's annual costs work out to per month.
 *
 * A subscription billed once in March is still money the business spends every
 * month; seeing it only in March makes eleven months look cheaper than they
 * are and March look like a disaster. So the yearly figures are added up and
 * divided by twelve.
 *
 * Rounded down, and only for rows that actually have an amount: an annual bill
 * nobody has entered yet must not quietly count as free, which is the same
 * rule the monthly costs follow.
 */
export function monthlyShareOfAnnual(annual: Array<{ amountCents: number | null }>): number {
  let year = 0;
  for (const row of annual) if (row.amountCents !== null) year += row.amountCents;
  return Math.floor(year / 12);
}

export interface ReconcileInput {
  /** What the row currently holds. */
  amountCents: number;
  /** The client's standing price from Settings, or null if they are not billed. */
  standingPriceCents: number | null;
  /** Set means the money arrived. */
  receivedAt: Date | null;
  /** Set once the operator types an amount over the top for this month. */
  priceOverridden: boolean;
}

/**
 * The amount a seeded revenue row should hold, or null to leave it alone.
 *
 * Settings holds what a client pays; a month row is a copy of it made at the
 * moment the month was first opened. The bug this fixes is that the copy was
 * never reconciled afterwards, so a month glanced at in advance kept whatever
 * the price happened to be that day. Caleb's price was corrected to $850 and
 * his August row went on saying $1,500 because August had been opened a week
 * earlier.
 *
 * Three things stop a row being touched, and each is a record of something
 * that really happened:
 *
 * - A hand-typed amount is the operator overruling Settings for this month.
 * - A paid month is history. Rewriting what was charged after the money
 *   arrived would put the books out against the invoice already sent.
 * - No standing price means the client is not billed, which is not an error.
 */
export function reconcilePrice(input: ReconcileInput): number | null {
  if (input.priceOverridden) return null;
  if (input.receivedAt !== null) return null;
  if (input.standingPriceCents === null) return null;
  if (input.standingPriceCents === input.amountCents) return null;
  return input.standingPriceCents;
}

export interface QuotaMetInput {
  quotaShort: number | null;
  quotaLong: number | null;
  quotaCarousel: number | null;
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
  delivered: { short: number; long: number; carousel: number },
): boolean {
  const hasTargets =
    input.quotaShort != null || input.quotaLong != null || input.quotaCarousel != null;
  if (!hasTargets) return input.billingMode !== "on_fulfilment";
  return (
    (input.quotaShort == null || delivered.short >= input.quotaShort) &&
    (input.quotaLong == null || delivered.long >= input.quotaLong) &&
    (input.quotaCarousel == null || delivered.carousel >= input.quotaCarousel)
  );
}
