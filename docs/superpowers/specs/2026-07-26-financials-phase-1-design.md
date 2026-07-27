# Financials, Phase 1: money in, money out

Design agreed with Tyrone on 2026-07-26. Covers backlog item B1, which the
improvement backlog calls "the single largest theme".

Status: **approved in design, not yet built.** Screen previewed and signed off.

---

## 1. What this is

A Financials screen answering three questions without any payment integration:

- Am I making money this month, and how does that compare?
- What am I spending on, and what is that costing me a year?
- What do I invoice this client, and what did they get for it?

Plus a year-end export a CPA can work from directly.

### Phase 1 explicitly excludes

Stripe, in either direction. No reading payments, no creating invoices in
Stripe, no charging anyone. **Nothing in Phase 1 can move money.** That is a
deliberate property, not an oversight: it means the whole phase can be built
and used without any possibility of sending a wrong invoice to a real client.

Also excluded: budgeting, runway and scenario planning (Phase 4, needs several
months of real history first), multi-currency, and payroll or contractor
costs, which Tyrone confirmed he does not have.

### The phases behind it

1. **This spec.** Pricing, expenses, invoices, profit view, tax export.
2. **Stripe, read only.** Reconcile real payments against these records.
3. **Stripe, write.** Create and send invoices, manage subscriptions.
4. **Planning.** Runway and forecasting over accumulated history.

Phase 2 is the honest prerequisite for Phase 3: you cannot safely write
invoices to an account until you can prove you read it correctly and match
Stripe customers to Toreroflow clients.

---

## 2. How Tyrone actually bills

Established by interview, and it is not a standard subscription.

**The price never varies with the video count.** Clients are on a retainer
tied to an agreed number of videos, but nobody is billed more for
over-delivery or credited for under-delivery. This kills the most complex
part of the module before it is written: there is **no over/under billing
arithmetic**, and quota does not compute money.

**There are two billing modes, and they differ per client.**

| Mode | Behaviour | Example |
|---|---|---|
| `calendar` | Paid monthly on a fixed day regardless of what was delivered. | Caleb |
| `on_fulfilment` | A payment buys a block of work. The next payment is not due until the previous block is delivered. If the content is not done by the billing day, work continues into the next month and the cycle slips. | Everyone else |

So **quota gates the timing of billing, never the amount.** For
`on_fulfilment` clients, "has this cycle been delivered" is exactly what
decides whether the next payment is due, and the app already tracks delivered
against target per period.

---

## 3. Data model

All money is stored as **integer cents**. Floats and money do not mix; a
rounding artefact in a profit total is the kind of bug that costs trust in
the whole screen permanently. Currency is USD throughout, with no currency
field, because adding one implies a conversion story that does not exist.

### 3.1 Client, extended

```
monthlyPriceCents   Int?
billingMode         String   @default("calendar")   // calendar | on_fulfilment
```

`monthlyPriceCents` is the **current default**, not a historical record. There
is deliberately no price-history table: history falls out of the ledger below,
because each month's figure is recorded when that month is opened. Raising a
price in March leaves January's recorded figure untouched.

There is deliberately no billing-day field. One was designed, built and then
removed during implementation: the status rule never read it, so it changed
nothing an operator could see. A field somebody fills in that has no effect is
worse than no field at all.

### 3.2 RevenueEntry

One row per client per month.

```
id, agencyId, clientId
month          String     // "2026-06"
amountCents    Int
receivedAt     DateTime?  // set means paid; the only stored state
note           String?
color          String?    // hex from the palette, see 3.6

@@unique([clientId, month])
```

Seeded from `Client.monthlyPriceCents` the first time a month is opened, then
freely editable, because real months do not always bill cleanly.

**There is no stored `status` column.** The screen shows three states and only
one of them is a fact the database can own:

- `paid`: `receivedAt` is set. Stored, because only a human knows the money
  arrived.
- `pending`: an `on_fulfilment` client whose cycle is not yet delivered. Shown
  as "Not due". Never applies to `calendar` clients.
- `due`: everything else, payable now. A `calendar` client is due for the whole
  month from the moment it opens, whatever the date and whatever was delivered.
  An `on_fulfilment` client becomes due once quota for the cycle is met.

`pending` and `due` are **derived on read** from billing mode and current quota
delivery. Storing them would go stale the moment a video was
delivered, and a stale "Not due" is exactly the error that loses you a
payment.

### 3.3 Expense

One row per cost per month, holding recurring and one-off in one table.

```
id, agencyId
name           String
categoryLine   String     // Schedule C line key, see section 4
amountCents    Int?       // null means the bill is not known yet
month          String     // "2026-06"
kind           String     // recurring | one_off
variable       Boolean    @default(false)
incurredOn     DateTime?  // one_off only, the actual date for the tax record
color          String?
note           String?
```

A separate template model for recurring costs plus actuals against it was
considered and rejected: two models to keep in sync for something one flag
does.

**`amountCents` is nullable, and null is load-bearing.** A variable cost whose
bill has not arrived is null, renders as **Missing** in red, and is excluded
from totals. It is deliberately not zero, because a tracker that silently
treats an unknown cost as free overstates profit every single month.

**Roll-forward:** opening a month with no expense rows copies forward the
previous month's `recurring` rows. Fixed costs arrive with their amount
filled in; `variable` ones arrive with `amountCents` null so the missing bill
is visible. `one_off` rows are never copied, which is what makes them one-off.

### 3.4 Invoice

```
id, agencyId, clientId
number         Int        // sequential per agency, starts at 1
issuedAt       DateTime
periodStart    DateTime
periodEnd      DateTime
amountCents    Int
status         String     // draft | sent | paid
storageKey     String?    // rendered PDF
lineItems      Json       // videos delivered in the cycle

@@unique([agencyId, number])
```

Displayed zero-padded to three digits ("001"). Tyrone confirmed he is starting
a fresh sequence, so there is no legacy numbering to continue from.

Numbers are allocated inside a transaction taking `max(number) + 1` for the
agency. Tax documents need stable identifiers, so a number is never reused or
renumbered, and a deleted invoice leaves its number burnt rather than
backfilling a gap.

`lineItems` is a snapshot, not a live join. An invoice must show what it
showed the day it was issued, even if a video is later deleted.

### 3.5 Agency, extended

Needed by the tax export, entered once in Settings.

```
legalName          String?
ein                String?
businessCode       String?   // NAICS principal business activity
accountingMethod   String?   // cash | accrual
```

### 3.6 Colour palette

Five colours, drawn from the existing design tokens so nothing introduces a
second palette:

`#57d6a0` green · `#4ea8ff` blue · `#8b7bff` violet · `#ffcf6b` amber · `#ff6b7a` red

Chosen per item from a glass dropdown on the row. The chosen colour is used
for that item's donut segment and its bar segment, so a category reads the
same everywhere. A null colour falls back to a deterministic assignment by
index, so charts are never grey before anything has been picked.

Field and identifier names use `color`, matching the existing codebase, which
uses that spelling in 43 places and the British one in none. User-facing label
text reads "Colour".

---

## 4. Expense categories are Schedule C lines

The categories are the IRS Schedule C Part II lines, not an invented
taxonomy. Consumer finance apps (Mint, YNAB) use personal-finance categories
that a CPA then has to translate; if the app's categories *are* the form's
lines, the export needs no translation.

| Key | Schedule C | Label shown | Emoji |
|---|---|---|---|
| `advertising` | Line 8 | Advertising | 📣 |
| `car` | Line 9 | Car and truck | 🚗 |
| `contract_labor` | Line 11 | Contract labor | 👷 |
| `depreciation` | Line 13 | Equipment | 📷 |
| `insurance` | Line 15 | Insurance | 🛡 |
| `legal_professional` | Line 17 | Legal and professional | ⚖️ |
| `office` | Line 18 | Office | 📎 |
| `rent_other` | Line 20b | Rent | 🏢 |
| `repairs` | Line 21 | Repairs | 🔧 |
| `supplies` | Line 22 | Supplies | 📦 |
| `travel` | Line 24a | Travel | ✈️ |
| `meals` | Line 24b | Meals | 🍽 |
| `utilities` | Line 25 | Utilities | 💡 |
| `software` | Line 27a | Subscriptions and software | 💻 |
| `other` | Line 27a | Other | 📌 |

**Utilities is utilities**: power, water, and the internet connection itself.
It does not absorb software, which is the single largest cost category in this
business and deserves to be readable on its own.

**Subscriptions and software is its own category**, covering Adobe, Anthropic,
ElevenLabs, Higgsfield, Netlify, Zernio and the rest. It has no dedicated
Schedule C line, so it maps to **Line 27a, Other expenses**, which is itemised
by description in Part V rather than being a single opaque total. `other`
remains as a genuine catch-all for anything fitting nowhere else.

Two keys mapping to the same line is correct rather than a modelling mistake:
Part V is a *list* of named other expenses, so the export emits
"Subscriptions and software" and "Other" as separate described entries that
sum to the Line 27a total. Collapsing them would lose the description a CPA
needs, and it would also make the biggest cost in the business invisible on
screen.

### The meals rule

**Business meals are 50% deductible for 2026.** The temporary 100% restaurant
deduction expired after 2022.

An expense in the `meals` category is stored and displayed at its **full
cost**, because that is what left the bank account and the monthly profit view
must be true. The tax export reports the **deductible half**. An $84.60 dinner
shows as $84.60 on screen and $42.30 on the export.

Getting this backwards in either direction is a real filing error, so the
halving happens in exactly one place (the export builder) and is covered by a
check.

---

## 5. The screen

Sidebar: **Overview → Dashboard, Financials.** A top-level destination with a
dollar-sign icon, not a report buried under Measure.

Month selector top right, matching the Reports screen.

**Top band, three cards.**
- *Net this month*, large figure, percent delta against last month, sparkline.
- *Money in*, donut segmented per client with a total in the centre, and
  horizontal breakdown bars beside it.
- *At a glance*, money in, recurring out, one-off out, year to date in, year
  to date net.

**Twelve-month bars.** Each bar is **money in**; the red portion is what it
cost, the green is what was kept. Total height is income, so the stack sums to
something true. Y-axis, and a hover callout with both figures.

**Money coming in.** One row per client: avatar pulled from their connected
social account, name, price, status tag, quota fulfilment beside it, colour
dropdown, delete. Rows for delivered `on_fulfilment` cycles show an **Invoice**
action.

**Money coming out.** Recurring costs only. Emoji, name, category, amount,
colour dropdown, delete. "Add a recurring cost" at the foot.

**One-off expenses.** Its own section. Counts toward this month's total and the
tax export, but never rolls forward.

**Export for taxes.** Year selector and one button.

The percent delta renders as a dash where there is no prior month, rather than
a fabricated `+0%`.

---

## 6. Documents

Both reuse the existing Chrome-based PDF renderer built for client reports. No
new dependency.

### 6.1 Invoice PDF

Business details, client contact details (from the Settings work already
shipped), invoice number, issue date, period covered, line items for the
videos delivered in that cycle, total, and payment terms.

An invoice document is **not** a Stripe invoice: it charges nobody. It exists
so the client has a record for their own accounts.

### 6.2 Year-end tax export

For a calendar year:

- Cover: legal name, EIN, principal business code, accounting method, year
- **Gross receipts**, total `paid` revenue, itemised per client
- **Expenses grouped by Schedule C line**, in line order, with each line's
  total and its constituent items
- Meals shown at full cost **and** at the deductible 50%, both labelled
- Monthly totals table: in, out, net
- A note stating the figures are cash-basis records from Toreroflow and not
  tax advice

---

## 7. Errors, edge cases, testing

**Money arithmetic lives in one pure module** (`lib/money.ts` or similar) with
a runnable check, following the `viewTiers` precedent set on 2026-07-26. The
check must cover: cents arithmetic with no float drift, totals excluding null
amounts, the meals 50% rule, roll-forward carrying fixed amounts but nulling
variable ones, and invoice number allocation not reusing a number.

**Failures surface as toasts**, using the system already shipped. Background
work, if any, raises a `SystemAlert` and clears on success.

**Edge cases decided:**

- A client with no `monthlyPriceCents` is listed with a dash and is not seeded
  into revenue. It is not an error.
- Deleting a client leaves its revenue and invoice history intact, because
  deleting a client must not silently rewrite last year's accounts.
- A month with no expenses at all is a real state, not an empty one: it means
  roll-forward has not run, and opening the month runs it.
- Editing a past month is allowed. Books get corrected.

---

## 8. Open questions

None blocking. Both have a stated default, so the build does not stall on
either.

1. **Resolved during implementation: there is no billing-day field.** It was
   built, found to be read by nothing, and removed. Revisit in Phase 2 only if
   real Stripe payment dates make a due-date concept earn its place.
2. **The tax export reports cash basis**: paid revenue only, excluding unpaid
   `due`. That matches the default `accountingMethod` of `cash`. If the field
   is set to `accrual`, the export includes `due` revenue and says so on the
   cover, because the two must never be ambiguous on a document going to a
   CPA.
