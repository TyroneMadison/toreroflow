# Financials completion: the full screen, and editable money coming in

Date: 2026-07-27
Status: approved
Source: "List of improvments for the app.md", item 2

## Context

The operator reports the Financials tab does not show the full finances and
wants it restored, plus the ability to edit the money-coming-in amounts at
will.

Investigation found the screen is not broken; it was never finished. The
Phase 1 spec (docs/superpowers/specs/2026-07-26-financials-phase-1-design.md,
section 5) defines eleven screen elements. Six were never implemented: the
Net-this-month card with delta and sparkline, the Money-in donut, the
At-a-glance card, the twelve-month bars, Money coming out, and One-off
expenses. What renders today (three plain tiles, revenue rows, export button)
is everything that exists. The signed-off static mockup with every section is
at storage/preview/financials.html and is the visual reference for this work.

Also confirmed:

- `PATCH /financials/revenue/:id` already accepts `amountCents`
  (financials.ts:293, financeSchemas.ts:52); no UI ever sends it.
- A client's standing price is editable only in the one-shot "no price set
  yet" branch of RevenueSection; after the first save no edit path exists
  anywhere, Settings included.
- Month roll-forward keeps copying recurring expense rows into new months
  with no UI to see, edit, or delete them.
- Nothing is connected to Stripe. All figures are manual bookkeeping.
- FinancialsScreen has no loading or error state: first paint and failed
  loads both show $0.00 with no cue, a failed refresh silently keeps stale
  data, and fast month switching has no stale-response guard.

## Decisions

- Build everything: all six missing sections, matching the signed-off mockup.
- Editing a Money coming in amount changes that month only. The data model
  already gives this for free: each month has its own `RevenueEntry` row and
  seeding is create-only, so the standing price is untouched.
- Permanent price changes live in Settings, not Financials.
- Charts are hand-rolled HTML/SVG/CSS per the mockup. No chart library.
- Money stays integer cents. An unknown expense amount stays null, never
  zero, so profit is never silently overstated.

## Design

### 1. Top band: three cards replace the three tiles

Per the mockup: a Net this month card (large figure, percent delta vs the
prior month, sparkline of recent months), a Money in donut (per-client
slices, total in the centre, horizontal per-client breakdown beside it), and
an At a glance card (money in, recurring out, one-off out, YTD in, YTD net).
The percent delta renders as a dash when there is no prior month, per the
Phase 1 spec.

### 2. Twelve-month bars

One bar per month across the last twelve: income height, red segment for
cost, green for kept, hover callout with the numbers.

### 3. Money coming in, full feature set

Each priced client row gains:

- Click the amount to edit it inline; save on blur or Enter, Escape cancels.
  Sends `amountCents` on the existing `PATCH /financials/revenue/:id`.
  Changes the selected month only.
- Quota fulfilment beside the status tag (delivered vs target for the month).
  The API already computes this internally and will now return the counts.
- Row delete, with the same confirm style Settings uses. Requires a new
  `DELETE /financials/revenue/:id` route.
- The Invoice button appears only on delivered `on_fulfilment` cycles, as the
  Phase 1 spec states, instead of on every non-pending row.

### 4. Money coming out, and One-off expenses

Two new sections matching the mockup: recurring costs and one-off expenses.
Each row: name, IRS Schedule C category (the existing
packages/core `expenseCategories` list), amount, color dot (reuse
ColorPicker), delete with confirm. An "Add a recurring cost" / "Add a
one-off expense" affordance opens an inline row form. Amount may be left
blank and stays null, displayed as "unknown", never $0.00. All three expense
routes already exist (`POST /financials/expenses`,
`PATCH /financials/expenses/:id`, `DELETE /financials/expenses/:id`); this is
UI only. These sections finally surface the rows roll-forward has been
creating invisibly.

### 5. Permanent prices in Settings

The expanded client card in Settings gains monthly price and billing mode
fields, saved like the contact fields, calling the existing
`PATCH /clients/:id/billing`. Financials keeps the one-shot editor for
unpriced clients; once priced, permanent changes happen in Settings and only
future months pick them up.

### 6. Honest loading and errors

FinancialsScreen gains a loading flag (dimmed skeleton tiles, no fake
$0.00), an error state with a retry button when the month fails to load, and
a request-sequence guard so a slow response for one month can never
overwrite a faster response for another.

### 7. Export year selector

The export card gets a year dropdown (current year back to the earliest year
with any financial row), replacing the hardcoded current year.

## API changes

All in apps/api:

- `GET /financials?month=` response gains:
  - `series`: the last twelve months of `{ month, inCents, outCents }` ending
    at the requested month, for the bars, sparkline, and delta.
  - `ytd`: `{ inCents, netCents }` for the requested month's year to date.
  - per revenue row: `quotaDelivered` and `quotaTarget` counts.
- New `DELETE /financials/revenue/:id`, agency-checked like the expense
  delete.
- No schema changes in packages/db. No new dependencies.

## Out of scope, recorded so it is not lost

- Agency tax details form (legalName, EIN, businessCode, accountingMethod).
  Still the top Financials backlog item; invoices and the export print
  without an EIN until it lands.
- Server-side validation that an invoiced cycle is actually due, and zod
  parsing of the invoice route body. Invoice hardening is its own item.
- The export's monthly totals table (Phase 1 spec section 6.2), and receipt
  bucketing by payment date vs billing month. Both remain open Financials
  items.
- Stripe or any payment movement.

## Verification

- A runnable check (`.check.ts` under tsx, repo style) for the new pure
  math: the twelve-month series assembly, YTD totals, and donut percentage
  math, including null-amount expenses excluded from sums but counted as
  missing bills.
- `pnpm -r typecheck`.
- Live walk in the app: edit a revenue amount and watch the donut, bars, and
  Net card move; add a recurring and a one-off expense and watch Money out
  and At a glance move; leave an expense amount blank and confirm it shows
  unknown, not $0.00, and the missing-bills warning appears; delete an
  expense and a revenue row; confirm the Invoice button only shows on
  delivered on_fulfilment cycles; change a price in Settings and confirm the
  current month is untouched while a future month seeds at the new price;
  kill the API and confirm the error state and retry appear with no fake
  $0.00; pick a prior year in the export selector and export.
- Clean up any test rows created during the walk.
