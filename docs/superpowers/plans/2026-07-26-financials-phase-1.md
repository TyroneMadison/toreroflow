# Financials Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Financials screen showing money in, money out and net per month, with client invoices and a year-end Schedule C export, and no ability to move money.

**Architecture:** Pure money arithmetic and the Schedule C category catalogue live in `@toreroflow/core` so the API and the desktop app share one source of truth. The API owns seeding and roll-forward, exposing one endpoint per month for the whole screen. The desktop screen is read-plus-mutate against that endpoint. Both PDFs reuse the existing Chrome renderer in `apps/api/src/reports/renderPdf.ts`.

**Tech Stack:** TypeScript, Prisma + PostgreSQL, Fastify, React 18 + Vite, Tauri v2, zod. Tests are `assert`-style `.check.ts` files run under `tsx`, matching `apps/desktop/src/lib/viewTiers.check.ts`. **There is no test framework in this repo. Do not add one.**

## Global Constraints

- **Money is integer cents everywhere.** Never a float, never a `Number` holding dollars. Copied from spec section 3.
- **Currency is USD.** No currency field, no conversion.
- **No Stripe in this phase.** Nothing built here may create a charge, a Stripe invoice, or a subscription. An invoice is a PDF document only.
- **Identifiers use `color`,** not `colour`. User-facing label text reads "Colour".
- **No em dashes** in code, comments, commit messages or user-facing copy. Use a comma, a full stop, or a hyphen.
- **Business meals are 50% deductible for 2026.** Stored and displayed at full cost; halved only in the tax export.
- **Colour palette is exactly:** `#57d6a0`, `#4ea8ff`, `#8b7bff`, `#ffcf6b`, `#ff6b7a`.
- **Comment style:** explain *why*, not *what*, matching the surrounding codebase.
- Run `pnpm -r typecheck` before every commit. It must pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/money.ts` | Cents arithmetic, formatting, the meals 50% rule |
| `packages/core/src/money.check.ts` | Runnable check for the above |
| `packages/core/src/expenseCategories.ts` | Schedule C catalogue: key, line, label, emoji |
| `packages/core/src/expenseCategories.check.ts` | Runnable check for the above |
| `packages/core/src/financeSchemas.ts` | zod bodies for the finance endpoints |
| `packages/db/prisma/schema.prisma` | RevenueEntry, Expense, Invoice, Client and Agency fields |
| `apps/api/src/financials/month.ts` | Seeding, roll-forward, month assembly, status derivation |
| `apps/api/src/financials/month.check.ts` | Runnable check for status derivation and roll-forward |
| `apps/api/src/routes/financials.ts` | HTTP surface for the month, expenses, revenue, invoices, export |
| `apps/api/src/financials/invoicePdf.ts` | Invoice document builder |
| `apps/api/src/financials/taxExport.ts` | Year-end Schedule C export builder |
| `apps/desktop/src/lib/financials.ts` | Client-side types and fetch helpers |
| `apps/desktop/src/screens/FinancialsScreen.tsx` | The screen |
| `apps/desktop/src/components/finance/*.tsx` | Row, colour dropdown, donut, bar chart |

---

## Task 1: Money arithmetic in core

**Files:**
- Create: `packages/core/src/money.ts`
- Create: `packages/core/src/money.check.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatCents(cents: number | null): string`, `sumCents(values: Array<number | null>): number`, `deductibleCents(categoryKey: string, cents: number): number`, `MEALS_DEDUCTIBLE_RATE: number`.

- [ ] **Step 1: Write the failing check**

Create `packages/core/src/money.check.ts`:

```typescript
import { deductibleCents, formatCents, MEALS_DEDUCTIBLE_RATE, sumCents } from "./money";

/** Local assert so the file typechecks with the app and needs no node types. */
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

eq(formatCents(0), "$0.00", "zero formats with cents");
eq(formatCents(5999), "$59.99", "cents are not rounded away");
eq(formatCents(355000), "$3,550.00", "thousands are separated");
eq(formatCents(null), "-", "unknown is a dash, never a zero");

eq(sumCents([5999, 14820, 7900]), 28719, "sums exactly, no float drift");
eq(sumCents([5999, null, 7900]), 13899, "a null amount is skipped, not treated as zero");
eq(sumCents([]), 0, "an empty list sums to zero");

// The rule that has real tax consequences.
eq(MEALS_DEDUCTIBLE_RATE, 0.5, "meals are 50% deductible for 2026");
eq(deductibleCents("meals", 8460), 4230, "a meal is halved for the export");
eq(deductibleCents("meals", 8461), 4230, "halving floors rather than inventing a cent");
eq(deductibleCents("software", 8460), 8460, "everything else is fully deductible");
eq(deductibleCents("travel", 10000), 10000, "travel is not a meal");

console.log("money: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "E:/Claude Stuff/Toreroflow/packages/core" && npx tsx src/money.check.ts
```

Expected: FAIL, `Cannot find module './money'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/money.ts`:

```typescript
/**
 * Money arithmetic for the Financials module.
 *
 * Every amount in this system is integer cents. Floats and money do not mix:
 * a rounding artefact in a profit total is the kind of bug that costs trust in
 * the whole screen permanently, and it is unrecoverable once a client has been
 * invoiced from it.
 */

/** Business meals are 50% deductible for 2026. The 100% relief expired after 2022. */
export const MEALS_DEDUCTIBLE_RATE = 0.5;

/**
 * Cents as currency. Null means "not known", which renders as a dash rather
 * than $0.00, because an unentered bill is not a free one.
 */
export function formatCents(cents: number | null): string {
  if (cents === null) return "-";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Sums cents, skipping unknowns. Integer throughout, so no drift. */
export function sumCents(values: Array<number | null>): number {
  let total = 0;
  for (const v of values) if (v !== null) total += v;
  return total;
}

/**
 * What the tax export may claim for this expense.
 *
 * Meals are halved and floored. Flooring rather than rounding because
 * inventing a cent in your own favour on a tax document is the wrong
 * direction to be wrong in.
 */
export function deductibleCents(categoryKey: string, cents: number): number {
  if (categoryKey !== "meals") return cents;
  return Math.floor(cents * MEALS_DEDUCTIBLE_RATE);
}
```

- [ ] **Step 4: Wire the export and the test script**

In `packages/core/src/index.ts`, add after the `reportSlug` line:

```typescript
export * from "./money";
```

In `packages/core/package.json`, add a `test` script and `tsx`:

```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "tsx src/money.check.ts && tsx src/expenseCategories.check.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0"
  }
```

Note the `test` script references `expenseCategories.check.ts`, created in Task 2. Until then run the check directly with the Step 2 command.

Then: `pnpm install`

- [ ] **Step 5: Run it to verify it passes**

```bash
cd "E:/Claude Stuff/Toreroflow/packages/core" && npx tsx src/money.check.ts
```

Expected: `money: all checks passed`

- [ ] **Step 6: Typecheck and commit**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

```bash
git add packages/core && git commit -m "feat: cents arithmetic and the meals deduction rule"
```

---

## Task 2: Schedule C category catalogue

**Files:**
- Create: `packages/core/src/expenseCategories.ts`
- Create: `packages/core/src/expenseCategories.check.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `deductibleCents` from Task 1.
- Produces: `EXPENSE_CATEGORIES: ExpenseCategory[]`, `categoryByKey(key: string): ExpenseCategory | null`, `type ExpenseCategory = { key, scheduleCLine, label, emoji }`.

- [ ] **Step 1: Write the failing check**

Create `packages/core/src/expenseCategories.check.ts`:

```typescript
import { categoryByKey, EXPENSE_CATEGORIES } from "./expenseCategories";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

eq(EXPENSE_CATEGORIES.length, 15, "fifteen categories");

// Keys are stored in the database, so a rename is a migration, not a tweak.
const keys = EXPENSE_CATEGORIES.map((c) => c.key).join(",");
eq(
  keys,
  "advertising,car,contract_labor,depreciation,insurance,legal_professional,office,rent_other,repairs,supplies,travel,meals,utilities,software,other",
  "category keys and their order are fixed",
);

eq(new Set(EXPENSE_CATEGORIES.map((c) => c.key)).size, 15, "keys are unique");

// Software and other deliberately share Line 27a: Part V is a list of named
// other expenses, so they stay separate rows that sum to that line.
eq(categoryByKey("software")?.scheduleCLine, "27a", "software maps to Other expenses");
eq(categoryByKey("other")?.scheduleCLine, "27a", "other maps to Other expenses");
eq(categoryByKey("software")?.label, "Subscriptions and software", "software is its own label");
eq(categoryByKey("utilities")?.label, "Utilities", "utilities does not absorb software");
eq(categoryByKey("meals")?.scheduleCLine, "24b", "meals is line 24b");
eq(categoryByKey("nonsense"), null, "an unknown key returns null, it does not throw");

for (const c of EXPENSE_CATEGORIES) {
  if (!c.emoji) throw new Error(`category ${c.key} has no emoji`);
  if (!c.label) throw new Error(`category ${c.key} has no label`);
}

console.log("expenseCategories: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "E:/Claude Stuff/Toreroflow/packages/core" && npx tsx src/expenseCategories.check.ts
```

Expected: FAIL, `Cannot find module './expenseCategories'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/expenseCategories.ts`:

```typescript
/**
 * Expense categories are the IRS Schedule C Part II lines, not an invented
 * taxonomy.
 *
 * Consumer finance apps use personal-finance categories a CPA then has to
 * translate. If the app's categories are the form's own lines, the year-end
 * export needs no translation at all.
 *
 * `key` is stored in the database. Renaming one is a migration, not an edit.
 */

export interface ExpenseCategory {
  key: string;
  /** Schedule C Part II line, as printed on the form. */
  scheduleCLine: string;
  label: string;
  emoji: string;
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { key: "advertising", scheduleCLine: "8", label: "Advertising", emoji: "📣" },
  { key: "car", scheduleCLine: "9", label: "Car and truck", emoji: "🚗" },
  { key: "contract_labor", scheduleCLine: "11", label: "Contract labor", emoji: "👷" },
  { key: "depreciation", scheduleCLine: "13", label: "Equipment", emoji: "📷" },
  { key: "insurance", scheduleCLine: "15", label: "Insurance", emoji: "🛡" },
  { key: "legal_professional", scheduleCLine: "17", label: "Legal and professional", emoji: "⚖️" },
  { key: "office", scheduleCLine: "18", label: "Office", emoji: "📎" },
  { key: "rent_other", scheduleCLine: "20b", label: "Rent", emoji: "🏢" },
  { key: "repairs", scheduleCLine: "21", label: "Repairs", emoji: "🔧" },
  { key: "supplies", scheduleCLine: "22", label: "Supplies", emoji: "📦" },
  { key: "travel", scheduleCLine: "24a", label: "Travel", emoji: "✈️" },
  { key: "meals", scheduleCLine: "24b", label: "Meals", emoji: "🍽" },
  { key: "utilities", scheduleCLine: "25", label: "Utilities", emoji: "💡" },
  // No dedicated line exists for software. Line 27a is itemised by
  // description in Part V, so this stays a named entry rather than an
  // opaque total, and stays readable on screen as the largest cost here.
  { key: "software", scheduleCLine: "27a", label: "Subscriptions and software", emoji: "💻" },
  { key: "other", scheduleCLine: "27a", label: "Other", emoji: "📌" },
];

const BY_KEY = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

/** Null rather than a throw: an unknown key is bad data, not a crash. */
export function categoryByKey(key: string): ExpenseCategory | null {
  return BY_KEY.get(key) ?? null;
}
```

- [ ] **Step 4: Export it**

In `packages/core/src/index.ts`, add:

```typescript
export * from "./expenseCategories";
```

- [ ] **Step 5: Run both checks to verify they pass**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm --filter @toreroflow/core test
```

Expected: `money: all checks passed` then `expenseCategories: all checks passed`.

- [ ] **Step 6: Typecheck and commit**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

```bash
git add packages/core && git commit -m "feat: Schedule C expense category catalogue"
```

---

## Task 3: Database schema

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_financials/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `RevenueEntry`, `Expense`, `Invoice`; `Client.monthlyPriceCents`, `Client.billingMode`; `Agency.legalName`, `Agency.ein`, `Agency.businessCode`, `Agency.accountingMethod`.

- [ ] **Step 1: Add the models**

In `packages/db/prisma/schema.prisma`, add to `model Client` beside the other optional fields:

```prisma
  /// Current retainer. A default for seeding a month, not a historical record:
  /// history lives in RevenueEntry, so raising this leaves past months alone.
  monthlyPriceCents    Int?
  /// calendar: paid monthly regardless of delivery.
  /// on_fulfilment: the next payment is not due until the last block ships.
  billingMode          String    @default("calendar")
  revenueEntries       RevenueEntry[]
  invoices             Invoice[]
```

Add to `model Agency`:

```prisma
  /// Stamped onto the year-end export. A CPA needs these, not just totals.
  legalName        String?
  ein              String?
  /// NAICS principal business activity code.
  businessCode     String?
  /// cash or accrual. Decides whether unpaid revenue appears in the export.
  accountingMethod String?   @default("cash")
  revenueEntries   RevenueEntry[]
  expenses         Expense[]
  invoices         Invoice[]
```

Add the three new models:

```prisma
/// What one client owes for one month.
model RevenueEntry {
  id          String    @id @default(cuid())
  agencyId    String
  clientId    String
  /// "2026-06"
  month       String
  amountCents Int
  /// Set means paid. The only stored state: pending and due are derived, since
  /// a stored "not due" goes stale the moment a video is delivered.
  receivedAt  DateTime?
  note        String?
  color       String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  agency Agency @relation(fields: [agencyId], references: [id])
  client Client @relation(fields: [clientId], references: [id])

  @@unique([clientId, month])
  @@index([agencyId, month])
}

/// One cost in one month. Holds recurring and one-off alike.
model Expense {
  id           String    @id @default(cuid())
  agencyId     String
  name         String
  /// Schedule C category key from @toreroflow/core.
  categoryLine String
  /// Null means the bill is not known yet. Deliberately not zero: treating an
  /// unknown cost as free overstates profit every month.
  amountCents  Int?
  month        String
  /// recurring rolls forward into the next month. one_off never does.
  kind         String    @default("recurring")
  /// A recurring cost whose amount changes monthly, so it rolls forward null.
  variable     Boolean   @default(false)
  /// one_off only: the date it actually happened, for the tax record.
  incurredOn   DateTime?
  color        String?
  note         String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  agency Agency @relation(fields: [agencyId], references: [id])

  @@index([agencyId, month])
}

/// A document, never a charge. Phase 1 cannot move money.
model Invoice {
  id          String   @id @default(cuid())
  agencyId    String
  clientId    String
  /// Sequential per agency from 1. Never reused, never renumbered: a deleted
  /// invoice burns its number rather than leaving a gap to backfill.
  number      Int
  issuedAt    DateTime @default(now())
  periodStart DateTime
  periodEnd   DateTime
  amountCents Int
  status      String   @default("draft")
  storageKey  String?
  /// Snapshot of what was delivered, not a live join: an invoice must show
  /// what it showed the day it was issued.
  lineItems   Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  agency Agency @relation(fields: [agencyId], references: [id])
  client Client @relation(fields: [clientId], references: [id])

  @@unique([agencyId, number])
  @@index([clientId])
}
```

- [ ] **Step 2: Generate the migration SQL**

The shadow database already exists from earlier work. Create the directory first so the diff has somewhere to write:

```bash
cd "E:/Claude Stuff/Toreroflow" && grep "^DATABASE_URL" .env | sed 's/DATABASE_URL=//' > /tmp/dburl.txt
```

```bash
cd "E:/Claude Stuff/Toreroflow/packages/db" && mkdir -p prisma/migrations/20260727000000_financials && DATABASE_URL="$(cat /tmp/dburl.txt)" npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$(cat /tmp/dburl.txt)_shadow" --script > prisma/migrations/20260727000000_financials/migration.sql
```

- [ ] **Step 3: Read the SQL before applying it**

```bash
cd "E:/Claude Stuff/Toreroflow" && cat packages/db/prisma/migrations/20260727000000_financials/migration.sql
```

Expected: three `CREATE TABLE` statements and two `ALTER TABLE` statements. **If it contains any `DROP TABLE` or `DROP COLUMN`, stop and investigate.** Nothing in this task removes anything.

- [ ] **Step 4: Apply and regenerate**

The API holds the Prisma query engine open, so stop it first or `generate` fails with EPERM on Windows.

```bash
cd "E:/Claude Stuff/Toreroflow" && powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*apps\api*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

```bash
cd "E:/Claude Stuff/Toreroflow/packages/db" && DATABASE_URL="$(cat /tmp/dburl.txt)" npx prisma migrate deploy && DATABASE_URL="$(cat /tmp/dburl.txt)" npx prisma generate
```

Expected: `All migrations have been successfully applied.` then `Generated Prisma Client`.

- [ ] **Step 5: Typecheck and commit**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

```bash
git add packages/db && git commit -m "feat: revenue, expense and invoice models"
```

---

## Task 4: Month assembly, status derivation and roll-forward

**Files:**
- Create: `apps/api/src/financials/month.ts`
- Create: `apps/api/src/financials/month.check.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `sumCents` from Task 1, models from Task 3.
- Produces: `deriveStatus(input: StatusInput): "paid" | "pending" | "due"`, `rollForward(previous: RollForwardRow[], month: string): RollForwardRow[]`, `type StatusInput`, `type RollForwardRow`.

- [ ] **Step 1: Write the failing check**

Create `apps/api/src/financials/month.check.ts`:

```typescript
import { deriveStatus, rollForward } from "./month";

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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "E:/Claude Stuff/Toreroflow/apps/api" && npx tsx src/financials/month.check.ts
```

Expected: FAIL, `Cannot find module './month'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/financials/month.ts`:

```typescript
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
```

- [ ] **Step 4: Add the API test script**

In `apps/api/package.json`, add to `scripts`:

```json
    "test": "tsx src/financials/month.check.ts"
```

- [ ] **Step 5: Run it to verify it passes**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm --filter @toreroflow/api test
```

Expected: `financials month: all checks passed`

- [ ] **Step 6: Typecheck and commit**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

```bash
git add apps/api && git commit -m "feat: revenue status derivation and expense roll-forward"
```

---

## Task 5: Financials month endpoint

**Files:**
- Create: `packages/core/src/financeSchemas.ts`
- Modify: `packages/core/src/index.ts`
- Create: `apps/api/src/routes/financials.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `deriveStatus`, `rollForward` from Task 4; `sumCents` from Task 1; `EXPENSE_CATEGORIES` from Task 2.
- Produces: `GET /financials?month=YYYY-MM`, `PATCH /clients/:id/billing`, `POST /financials/expenses`, `PATCH /financials/expenses/:id`, `DELETE /financials/expenses/:id`, `PATCH /financials/revenue/:id`.

- [ ] **Step 1: Add the request schemas**

Create `packages/core/src/financeSchemas.ts`:

```typescript
import { z } from "zod";

/** "2026-06". Rejected early so a bad month never reaches a query. */
export const monthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

const HEX = /^#[0-9a-fA-F]{6}$/;

export const billingSchema = z.object({
  monthlyPriceCents: z.number().int().min(0).max(100_000_000).nullish(),
  billingMode: z.enum(["calendar", "on_fulfilment"]).optional(),
});

export const expenseSchema = z.object({
  name: z.string().min(1).max(120),
  categoryLine: z.string().min(1).max(40),
  amountCents: z.number().int().min(0).max(100_000_000).nullish(),
  month: monthKeySchema,
  kind: z.enum(["recurring", "one_off"]).default("recurring"),
  variable: z.boolean().default(false),
  incurredOn: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: z.string().max(500).nullish(),
});

export const expenseUpdateSchema = expenseSchema.partial();

export const revenueUpdateSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  /** ISO date, or null to mark unpaid again. */
  receivedAt: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: z.string().max(500).nullish(),
});
```

Add to `packages/core/src/index.ts`:

```typescript
export * from "./financeSchemas";
```

- [ ] **Step 2: Write the route**

Create `apps/api/src/routes/financials.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import {
  billingSchema,
  EXPENSE_CATEGORIES,
  expenseSchema,
  expenseUpdateSchema,
  monthKeySchema,
  revenueUpdateSchema,
  sumCents,
} from "@toreroflow/core";
import { requireAuth } from "../plugins/requireAuth";
import { deriveStatus, rollForward } from "../financials/month";

const NOT_FOUND = { error: "not found" } as const;

/** First moment of the month a "2026-06" key names. */
function monthStart(key: string): Date {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1);
}

/** The month before a "2026-06" key, as a key. */
function previousMonth(key: string): string {
  const d = monthStart(key);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function financialsRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get<{ Querystring: { month?: string } }>("/financials", async (request, reply) => {
    const parsed = monthKeySchema.safeParse(
      request.query.month ??
        `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
    );
    if (!parsed.success) return reply.status(400).send({ error: "month must be YYYY-MM" });
    const month = parsed.data;
    const agencyId = request.user.agencyId;

    const clients = await prisma.client.findMany({
      where: { agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        avatarSeed: true,
        monthlyPriceCents: true,
        billingMode: true,
        quotaShort: true,
        quotaLong: true,
        quotaResetAt: true,
        adjustShort: true,
        adjustLong: true,
        socialAccounts: {
          where: { deletedAt: null },
          select: { avatarUrl: true },
        },
      },
    });

    // Seed the month from each client's current price. Only for clients that
    // have one: a client with no price is not an error, it is just not billed.
    for (const c of clients) {
      if (c.monthlyPriceCents == null) continue;
      await prisma.revenueEntry.upsert({
        where: { clientId_month: { clientId: c.id, month } },
        create: { agencyId, clientId: c.id, month, amountCents: c.monthlyPriceCents },
        update: {},
      });
    }

    // Roll recurring costs forward the first time a month is opened. An empty
    // month means roll-forward has not run, not that there are no costs.
    const existing = await prisma.expense.count({ where: { agencyId, month } });
    if (existing === 0) {
      const prev = await prisma.expense.findMany({
        where: { agencyId, month: previousMonth(month) },
      });
      const carried = rollForward(
        prev.map((e) => ({
          name: e.name,
          categoryLine: e.categoryLine,
          amountCents: e.amountCents,
          kind: e.kind,
          variable: e.variable,
          color: e.color,
        })),
        month,
      );
      if (carried.length) {
        await prisma.expense.createMany({
          data: carried.map((r) => ({
            agencyId,
            name: r.name,
            categoryLine: r.categoryLine,
            amountCents: r.amountCents,
            month,
            kind: r.kind,
            variable: r.variable,
            color: r.color,
          })),
        });
      }
    }

    const [revenue, expenses] = await Promise.all([
      prisma.revenueEntry.findMany({ where: { agencyId, month } }),
      prisma.expense.findMany({ where: { agencyId, month }, orderBy: { createdAt: "asc" } }),
    ]);

    const now = new Date();
    const byClient = new Map(clients.map((c) => [c.id, c]));

    // Delivered counts per client for the current quota period, counted the
    // same way the quota card and Account Overview count them, so three
    // screens cannot disagree about whether a cycle is finished.
    const deliveredByClient = new Map<string, { short: number; long: number }>();
    for (const c of clients) {
      const since = c.quotaResetAt ?? new Date(0);
      const base = { clientId: c.id, createdAt: { gte: since }, isRevision: false };
      const [shortCount, longCount] = await Promise.all([
        prisma.mediaAsset.count({ where: { ...base, format: { in: ["short_form"] } } }),
        prisma.mediaAsset.count({ where: { ...base, format: "long_form" } }),
      ]);
      deliveredByClient.set(c.id, {
        short: Math.max(0, shortCount + c.adjustShort),
        long: Math.max(0, longCount + c.adjustLong),
      });
    }

    const revenueRows = revenue.map((r) => {
      const c = byClient.get(r.clientId);
      // Met means every tracked format has reached its target. A client with
      // no targets at all counts as met, because there is nothing to wait for.
      const d = deliveredByClient.get(r.clientId) ?? { short: 0, long: 0 };
      const quotaMet =
        !c ||
        ((c.quotaShort == null || d.short >= c.quotaShort) &&
          (c.quotaLong == null || d.long >= c.quotaLong));
      return {
        id: r.id,
        clientId: r.clientId,
        clientName: c?.name ?? "Unknown",
        avatarUrl: c?.socialAccounts.find((a) => a.avatarUrl)?.avatarUrl ?? null,
        avatarSeed: c?.avatarSeed ?? null,
        amountCents: r.amountCents,
        color: r.color,
        note: r.note,
        receivedAt: r.receivedAt,
        status: deriveStatus({
          receivedAt: r.receivedAt,
          billingMode: c?.billingMode ?? "calendar",
          quotaMet,
        }),
      };
    });

    const recurring = expenses.filter((e) => e.kind === "recurring");
    const oneOff = expenses.filter((e) => e.kind === "one_off");

    return {
      month,
      categories: EXPENSE_CATEGORIES,
      revenue: revenueRows,
      recurring,
      oneOff,
      totals: {
        inCents: sumCents(revenueRows.map((r) => r.amountCents)),
        recurringOutCents: sumCents(recurring.map((e) => e.amountCents)),
        oneOffOutCents: sumCents(oneOff.map((e) => e.amountCents)),
        // Unknown bills are excluded from the total and reported separately so
        // the screen can say the figure is incomplete rather than pretend.
        missingBills: expenses.filter((e) => e.amountCents === null).length,
      },
    };
  });

  app.patch<{ Params: { id: string } }>("/clients/:id/billing", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);
    const body = billingSchema.parse(request.body);
    return await prisma.client.update({
      where: { id: client.id },
      data: {
        ...(body.monthlyPriceCents !== undefined ? { monthlyPriceCents: body.monthlyPriceCents } : {}),
        ...(body.billingMode !== undefined ? { billingMode: body.billingMode } : {}),
      },
      select: { monthlyPriceCents: true, billingMode: true },
    });
  });

  app.post("/financials/expenses", async (request) => {
    const body = expenseSchema.parse(request.body);
    return await prisma.expense.create({
      data: {
        agencyId: request.user.agencyId,
        name: body.name,
        categoryLine: body.categoryLine,
        amountCents: body.amountCents ?? null,
        month: body.month,
        kind: body.kind,
        variable: body.variable,
        incurredOn: body.incurredOn ? new Date(body.incurredOn) : null,
        color: body.color ?? null,
        note: body.note ?? null,
      },
    });
  });

  app.patch<{ Params: { id: string } }>("/financials/expenses/:id", async (request, reply) => {
    const found = await prisma.expense.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    const body = expenseUpdateSchema.parse(request.body);
    return await prisma.expense.update({
      where: { id: found.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.categoryLine !== undefined ? { categoryLine: body.categoryLine } : {}),
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.incurredOn !== undefined
          ? { incurredOn: body.incurredOn ? new Date(body.incurredOn) : null }
          : {}),
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/financials/expenses/:id", async (request, reply) => {
    const found = await prisma.expense.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    await prisma.expense.delete({ where: { id: found.id } });
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/financials/revenue/:id", async (request, reply) => {
    const found = await prisma.revenueEntry.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    const body = revenueUpdateSchema.parse(request.body);
    return await prisma.revenueEntry.update({
      where: { id: found.id },
      data: {
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.receivedAt !== undefined
          ? { receivedAt: body.receivedAt ? new Date(body.receivedAt) : null }
          : {}),
      },
    });
  });
}
```

- [ ] **Step 3: Register the route**

In `apps/api/src/server.ts`, add the import beside the others:

```typescript
import { financialsRoutes } from "./routes/financials";
```

and the registration after `overviewRoutes`:

```typescript
  await app.register(financialsRoutes);
```

- [ ] **Step 4: Typecheck**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 5: Exercise it against the running API**

Start the API, then mint a token if one is not to hand. The user id and agency id come from the database:

```bash
cd "E:/Claude Stuff/Toreroflow" && docker exec toreroflow-postgres psql -U toreroflow -d toreroflow -t -A -F'|' -c 'SELECT id, "agencyId" FROM "User" LIMIT 1;'
```

```bash
cd "E:/Claude Stuff/Toreroflow" && curl -s "http://localhost:4700/financials?month=2026-07" -H "Authorization: Bearer $(cat /tmp/tok.txt)" | head -c 600
```

Expected: JSON with `month`, `categories` (15 entries), `revenue`, `recurring`, `oneOff`, `totals`. Revenue is empty until a client has a price, which is correct.

Then set a price and confirm seeding:

```bash
cd "E:/Claude Stuff/Toreroflow" && curl -s -X PATCH "http://localhost:4700/clients/<CLIENT_ID>/billing" -H "Authorization: Bearer $(cat /tmp/tok.txt)" -H "Content-Type: application/json" -d '{"monthlyPriceCents":150000,"billingMode":"calendar"}'
```

Expected: the price echoes back, and a second `GET /financials?month=2026-07` now has one revenue row with `amountCents: 150000` and `status: "due"`.

- [ ] **Step 6: Commit**

```bash
git add packages/core apps/api && git commit -m "feat: financials month endpoint with seeding and roll-forward"
```

---

## Task 6: Financials screen, nav and read-only render

**Files:**
- Create: `apps/desktop/src/lib/financials.ts`
- Create: `apps/desktop/src/screens/FinancialsScreen.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/components/IconDefs.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `GET /financials` from Task 5.
- Produces: `type FinancialsMonth`, `type RevenueRow`, `type ExpenseRow` from `lib/financials.ts`; screen id `"financials"`.

- [ ] **Step 1: Add the client types**

Create `apps/desktop/src/lib/financials.ts`:

```typescript
import type { ExpenseCategory } from "@toreroflow/core";

export interface RevenueRow {
  id: string;
  clientId: string;
  clientName: string;
  avatarUrl: string | null;
  avatarSeed: string | null;
  amountCents: number;
  color: string | null;
  note: string | null;
  receivedAt: string | null;
  status: "paid" | "pending" | "due";
}

export interface ExpenseRow {
  id: string;
  name: string;
  categoryLine: string;
  /** Null means the bill is not known yet, which is not zero. */
  amountCents: number | null;
  month: string;
  kind: "recurring" | "one_off";
  variable: boolean;
  incurredOn: string | null;
  color: string | null;
  note: string | null;
}

export interface FinancialsMonth {
  month: string;
  categories: ExpenseCategory[];
  revenue: RevenueRow[];
  recurring: ExpenseRow[];
  oneOff: ExpenseRow[];
  totals: {
    inCents: number;
    recurringOutCents: number;
    oneOffOutCents: number;
    missingBills: number;
  };
}

/** The five colours a row may take. Matches the design tokens. */
export const FINANCE_COLORS = ["#57d6a0", "#4ea8ff", "#8b7bff", "#ffcf6b", "#ff6b7a"] as const;

/** Stable fallback so a chart is never grey before anything is picked. */
export function colorFor(color: string | null, index: number): string {
  return color ?? FINANCE_COLORS[index % FINANCE_COLORS.length]!;
}
```

- [ ] **Step 2: Add the dollar icon**

In `apps/desktop/src/components/IconDefs.tsx`, add beside the other symbols:

```tsx
      <symbol id="i-usd" viewBox="0 0 24 24">
        <path d="M12 2v20M17 6.5c0-2-2.2-3.5-5-3.5S7 4.5 7 6.5s2 3 5 3.5 5 1.5 5 3.5-2.2 3.5-5 3.5-5-1.5-5-3.5" />
      </symbol>
```

- [ ] **Step 3: Write the screen**

Create `apps/desktop/src/screens/FinancialsScreen.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toasts";
import { formatCents } from "@toreroflow/core";
import { api } from "../lib/api";
import type { FinancialsMonth } from "../lib/financials";

/** Months to offer, newest first, starting from the current one. */
function monthOptions(count = 12): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

export default function FinancialsScreen() {
  const toast = useToast();
  const months = monthOptions();
  const [month, setMonth] = useState(months[0]!.value);
  const [data, setData] = useState<FinancialsMonth | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<FinancialsMonth>(`/financials?month=${month}`));
    } catch (err) {
      toast.fail("Could not load the month", err);
    }
  }, [month, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = data?.totals;
  const outCents = (t?.recurringOutCents ?? 0) + (t?.oneOffOutCents ?? 0);
  const netCents = (t?.inCents ?? 0) - outCents;

  return (
    <section className="screen active" data-screen="financials">
      <div className="topbar">
        <div className="h">
          <h2>Financials</h2>
          <p>What came in, what went out, and what is left.</p>
        </div>
        <select
          className="field-in repmonth"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="stage">
        <div className="fintiles">
          <div className="fintile glass in">
            <div className="lbl">Money in</div>
            <div className="num">{formatCents(t?.inCents ?? 0)}</div>
          </div>
          <div className="fintile glass out">
            <div className="lbl">Money out</div>
            <div className="num">{formatCents(outCents)}</div>
            {t && t.missingBills > 0 && (
              <div className="warnline">
                {t.missingBills} bill{t.missingBills === 1 ? "" : "s"} not entered, so this is
                incomplete
              </div>
            )}
          </div>
          <div className="fintile glass net">
            <div className="lbl">Net</div>
            <div className="num">{formatCents(netCents)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire the nav and route**

In `apps/desktop/src/components/Sidebar.tsx`, add to `OVERVIEW_NAV` after Dashboard:

```typescript
  { target: "financials", icon: "#i-usd", label: "Financials" },
```

In `apps/desktop/src/App.tsx`, add `| "financials"` to `ScreenId`, import the screen, and render it:

```tsx
          {activeScreen === "financials" && <FinancialsScreen key="financials" />}
```

- [ ] **Step 5: Add the styles**

Append to `apps/desktop/src/styles.css`:

```css

/* ---- Financials ---- */
.fintiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.fintile{padding:18px 20px}
.fintile .lbl{font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt-3);font-weight:600}
.fintile .num{font-size:28px;font-weight:680;letter-spacing:-.5px;margin-top:8px}
.fintile.in .num{color:var(--green)}
.fintile.out .num{color:var(--red)}
.fintile.net .num{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.fintile .warnline{font-size:10.5px;color:var(--amber);margin-top:7px;line-height:1.4}
```

- [ ] **Step 6: Typecheck and verify in the app**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

Open the app at `http://localhost:1420`, click **Financials** under Overview. Expected: three tiles showing the month's figures, and the incomplete-bills warning if any expense has no amount.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop && git commit -m "feat: Financials screen with the month totals"
```

---

## Task 7: The three sections, with add, edit, delete and colour

**Files:**
- Create: `apps/desktop/src/components/finance/ColorPicker.tsx`
- Create: `apps/desktop/src/components/finance/ExpenseSection.tsx`
- Modify: `apps/desktop/src/screens/FinancialsScreen.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `FinancialsMonth`, `colorFor`, `FINANCE_COLORS` from Task 6; the expense endpoints from Task 5.
- Produces: `<ColorPicker value onChange />`, `<ExpenseSection title rows categories kind onChanged />`.

- [ ] **Step 1: Write the colour picker**

Create `apps/desktop/src/components/finance/ColorPicker.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { FINANCE_COLORS } from "../../lib/financials";

/**
 * Per-row colour, chosen from a glass dropdown.
 *
 * The chosen colour is used for this row's donut segment and bar segment, so
 * a category reads the same everywhere on the screen.
 */
export default function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange(color: string): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="cwrap" ref={wrap}>
      <div
        className={`cbtn${open ? " open" : ""}`}
        title="Colour"
        onClick={() => setOpen((o) => !o)}
      >
        <i style={{ background: value, color: value }} />
      </div>
      {open && (
        <div className="cmenu">
          {FINANCE_COLORS.map((c) => (
            <span
              key={c}
              className={`sw${c === value ? " on" : ""}`}
              style={{ background: c }}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the expense section**

Create `apps/desktop/src/components/finance/ExpenseSection.tsx`:

```tsx
import { useState } from "react";
import type { ExpenseCategory } from "@toreroflow/core";
import { formatCents } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import { colorFor, type ExpenseRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

/**
 * Recurring costs or one-off costs.
 *
 * One component for both because the row is identical and only the copy and
 * the `kind` differ. Recurring rows roll into next month; one-off rows do not,
 * which is the whole distinction.
 */
export default function ExpenseSection({
  title,
  sub,
  kind,
  rows,
  categories,
  month,
  totalCents,
  onChanged,
}: {
  title: string;
  sub: string;
  kind: "recurring" | "one_off";
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  month: string;
  totalCents: number;
  onChanged(): void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", amount: "", categoryLine: "software" });

  const catOf = (key: string) => categories.find((c) => c.key === key) ?? null;

  const add = async () => {
    const cents = Math.round(Number.parseFloat(draft.amount || "0") * 100);
    if (!draft.name.trim() || Number.isNaN(cents)) return;
    try {
      await api.post("/financials/expenses", {
        name: draft.name.trim(),
        categoryLine: draft.categoryLine,
        amountCents: cents,
        month,
        kind,
        variable: false,
      });
      setDraft({ name: "", amount: "", categoryLine: "software" });
      setAdding(false);
      onChanged();
    } catch (err) {
      toast.fail(`Could not add ${draft.name.trim() || "the expense"}`, err);
    }
  };

  const remove = async (row: ExpenseRow) => {
    try {
      await api.del(`/financials/expenses/${row.id}`);
      onChanged();
    } catch (err) {
      toast.fail(`Could not remove ${row.name}`, err);
    }
  };

  const setColor = async (row: ExpenseRow, color: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, { color });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recolour ${row.name}`, err);
    }
  };

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>{title}</h3>
          <div className="sub">{sub}</div>
        </div>
        <div className="amt o">{formatCents(totalCents)}</div>
      </div>

      {rows.map((row, i) => {
        const cat = catOf(row.categoryLine);
        const missing = row.amountCents === null;
        return (
          <div className={`lrow${missing ? " missing" : ""}`} key={row.id}>
            <div className="cat">{cat?.emoji ?? "📌"}</div>
            <div className="lmeta">
              <b>{row.name}</b>
              <span>
                {cat?.label ?? row.categoryLine}
                {row.variable ? " · usage" : ""}
                {row.kind === "one_off" && row.categoryLine === "meals"
                  ? ` · 50% deductible, ${formatCents(Math.floor((row.amountCents ?? 0) / 2))} claimable`
                  : ""}
              </span>
            </div>
            {missing && <span className="tag miss">Missing</span>}
            <div className="amt o">{formatCents(row.amountCents)}</div>
            <ColorPicker
              value={colorFor(row.color, i)}
              onChange={(c) => void setColor(row, c)}
            />
            <div className="del" title="Remove" onClick={() => void remove(row)}>
              <svg>
                <use href="#i-x" />
              </svg>
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="addform">
          <input
            className="field-in"
            placeholder="What is it"
            value={draft.name}
            autoFocus
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <select
            className="field-in"
            value={draft.categoryLine}
            onChange={(e) => setDraft((d) => ({ ...d, categoryLine: e.target.value }))}
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.emoji} {c.label}
              </option>
            ))}
          </select>
          <input
            className="field-in"
            placeholder="0.00"
            inputMode="decimal"
            value={draft.amount}
            onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <button className="btn" onClick={() => void add()}>
            Add
          </button>
          <button className="btn ghost" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="addrow" onClick={() => setAdding(true)}>
          ＋ {kind === "recurring" ? "Add a recurring cost" : "Add a one-off expense"}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Render both sections in the screen**

In `apps/desktop/src/screens/FinancialsScreen.tsx`, import and render below the tiles:

```tsx
import ExpenseSection from "../components/finance/ExpenseSection";
```

```tsx
        {data && (
          <>
            <div className="fincols">
              <ExpenseSection
                title="Money coming out"
                sub="Recurring only. Rolls forward each month."
                kind="recurring"
                rows={data.recurring}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.recurringOutCents}
                onChanged={() => void load()}
              />
            </div>
            <div style={{ marginTop: 16 }}>
              <ExpenseSection
                title="One-off expenses"
                sub="This month only. Never rolls forward, still counts toward your taxes."
                kind="one_off"
                rows={data.oneOff}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.oneOffOutCents}
                onChanged={() => void load()}
              />
            </div>
          </>
        )}
```

- [ ] **Step 4: Add the styles**

Append to `apps/desktop/src/styles.css`:

```css
.fincols{margin-top:16px}
.lrow.missing{border-color:rgba(255,107,122,.30);background:rgba(255,107,122,.06)}
.addform{display:flex;gap:8px;align-items:center;margin-top:9px;padding:10px 12px;border-radius:16px;
  border:1px dashed rgba(255,255,255,.17)}
.addform .field-in{flex:1;font-size:12.5px;padding:8px 10px}
.addform .field-in:nth-child(3){max-width:110px}
.addform .btn{padding:8px 14px;font-size:12px}
```

- [ ] **Step 5: Verify in the app**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

In the app: add a recurring cost named "Adobe" at 59.99 under Subscriptions and software. Expected: the row appears, the Money out tile increases by $59.99, and Net decreases by the same. Change its colour, reload the page, and confirm the colour persisted. Delete it and confirm the tiles return.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop && git commit -m "feat: add, remove and colour expenses on the Financials screen"
```

---

## Task 8: Money coming in, with quota and payment marking

**Files:**
- Create: `apps/desktop/src/components/finance/RevenueSection.tsx`
- Modify: `apps/desktop/src/screens/FinancialsScreen.tsx`

**Interfaces:**
- Consumes: `RevenueRow` from Task 6; `PATCH /financials/revenue/:id` from Task 5.
- Produces: `<RevenueSection rows totalCents onChanged />`.

- [ ] **Step 1: Write the section**

Create `apps/desktop/src/components/finance/RevenueSection.tsx`:

```tsx
import { formatCents } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import { colorFor, type RevenueRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

const STATUS_LABEL: Record<RevenueRow["status"], string> = {
  paid: "Paid",
  pending: "Not due",
  due: "Due",
};

/**
 * What each client owes this month.
 *
 * "Not due" only ever appears for a fulfilment-gated client whose cycle is
 * unfinished, which is the signal for whether you have earned the right to
 * ask for the next payment.
 */
export default function RevenueSection({
  rows,
  totalCents,
  onChanged,
}: {
  rows: RevenueRow[];
  totalCents: number;
  onChanged(): void;
}) {
  const toast = useToast();

  const togglePaid = async (row: RevenueRow) => {
    try {
      await api.patch(`/financials/revenue/${row.id}`, {
        receivedAt: row.status === "paid" ? null : new Date().toISOString(),
      });
      onChanged();
    } catch (err) {
      toast.fail(`Could not update ${row.clientName}`, err);
    }
  };

  const setColor = async (row: RevenueRow, color: string) => {
    try {
      await api.patch(`/financials/revenue/${row.id}`, { color });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recolour ${row.clientName}`, err);
    }
  };

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Money coming in</h3>
          <div className="sub">Click the tag to mark a month paid.</div>
        </div>
        <div className="amt i">{formatCents(totalCents)}</div>
      </div>

      {rows.length === 0 ? (
        <div className="btnote" style={{ marginTop: 10 }}>
          No client has a monthly price yet. Set one on a brand to start tracking revenue.
        </div>
      ) : (
        rows.map((row, i) => (
          <div className="lrow" key={row.id}>
            <div className="av">
              {row.avatarUrl ? (
                <img src={row.avatarUrl} alt="" />
              ) : (
                (row.avatarSeed ?? row.clientName.slice(0, 2).toUpperCase())
              )}
            </div>
            <div className="lmeta">
              <b>{row.clientName}</b>
              <span>
                {row.status === "paid" && row.receivedAt
                  ? `Paid ${new Date(row.receivedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                  : row.status === "pending"
                    ? "Cycle opens once delivered"
                    : "Payable now"}
              </span>
            </div>
            <div className="amt i">{formatCents(row.amountCents)}</div>
            <span
              className={`tag ${row.status === "paid" ? "paid" : row.status === "pending" ? "due" : "warn"}`}
              style={{ cursor: "pointer" }}
              title={row.status === "paid" ? "Mark unpaid" : "Mark paid"}
              onClick={() => void togglePaid(row)}
            >
              {STATUS_LABEL[row.status]}
            </span>
            <ColorPicker
              value={colorFor(row.color, i)}
              onChange={(c) => void setColor(row, c)}
            />
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render it above the expense sections**

In `FinancialsScreen.tsx`, inside the `data &&` block, before `.fincols`:

```tsx
            <RevenueSection
              rows={data.revenue}
              totalCents={data.totals.inCents}
              onChanged={() => void load()}
            />
```

with the import:

```tsx
import RevenueSection from "../components/finance/RevenueSection";
```

- [ ] **Step 3: Add the missing tag style**

Append to `apps/desktop/src/styles.css`:

```css
.tag.warn{color:var(--amber);background:rgba(255,207,107,.14)}
```

- [ ] **Step 4: Verify in the app**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

In the app: click a client's status tag. Expected: it flips to **Paid** with today's date, and clicking again returns it to **Due**. Reload and confirm it persisted.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop && git commit -m "feat: money coming in with payment marking"
```

---

## Task 9: Invoice document

**Files:**
- Create: `apps/api/src/financials/invoicePdf.ts`
- Create: `assets/invoice-template.html`
- Modify: `apps/api/src/routes/financials.ts`
- Modify: `apps/desktop/src/components/finance/RevenueSection.tsx`

**Interfaces:**
- Consumes: `renderReportPdf` from `apps/api/src/reports/renderPdf.ts`; `Invoice` model from Task 3.
- Produces: `POST /financials/invoices` returning `{ id, number, url }`.

- [ ] **Step 1: Write the invoice builder**

Create `apps/api/src/financials/invoicePdf.ts`:

```typescript
import { formatCents } from "@toreroflow/core";

export interface InvoiceLine {
  title: string;
  publishedAt: string | null;
}

export interface InvoiceData {
  number: string;
  issuedAt: string;
  periodLabel: string;
  business: { legalName: string; ein: string | null };
  client: { name: string; contactName: string | null; contactEmail: string | null };
  amountCents: number;
  lines: InvoiceLine[];
}

/** Escapes text destined for an HTML text node. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The invoice document.
 *
 * A document, not a charge: nothing here can take money. It exists so the
 * client has a record of what they paid for, itemised by what actually
 * shipped in the cycle.
 */
export function buildInvoiceHtml(data: InvoiceData): string {
  const lines = data.lines.length
    ? data.lines
        .map(
          (l) =>
            `<tr><td>${esc(l.title)}</td><td class="r">${
              l.publishedAt ? new Date(l.publishedAt).toLocaleDateString("en-US") : ""
            }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No videos recorded for this period.</td></tr>`;

  return `<!doctype html><meta charset="utf-8"><title>Invoice ${esc(data.number)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#111;margin:0;padding:48px 56px}
  h1{font-size:26px;margin:0 0 4px}
  .muted{color:#777}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:34px}
  .box{font-size:13px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px}
  th,td{text-align:left;padding:9px 0;border-bottom:1px solid #e6e6e6}
  th{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#888}
  td.r,th.r{text-align:right}
  .total{margin-top:26px;font-size:20px;font-weight:700;text-align:right}
  .foot{margin-top:40px;font-size:11px;color:#888;line-height:1.6}
</style>
<div class="head">
  <div>
    <h1>Invoice ${esc(data.number)}</h1>
    <div class="muted">${esc(data.periodLabel)}</div>
  </div>
  <div class="box" style="text-align:right">
    <b>${esc(data.business.legalName)}</b><br>
    ${data.business.ein ? `EIN ${esc(data.business.ein)}<br>` : ""}
    Issued ${esc(new Date(data.issuedAt).toLocaleDateString("en-US"))}
  </div>
</div>
<div class="box">
  <b>Billed to</b><br>
  ${esc(data.client.name)}<br>
  ${data.client.contactName ? `${esc(data.client.contactName)}<br>` : ""}
  ${data.client.contactEmail ? `${esc(data.client.contactEmail)}` : ""}
</div>
<table>
  <tr><th>Delivered</th><th class="r">Published</th></tr>
  ${lines}
</table>
<div class="total">${esc(formatCents(data.amountCents))}</div>
<div class="foot">Generated by Toreroflow. This document is a record of work delivered and payment agreed, not a payment request processed by this application.</div>`;
}
```

- [ ] **Step 2: Add the endpoint**

In `apps/api/src/routes/financials.ts`, add the imports:

```typescript
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { env } from "../env";
import { renderReportPdf } from "../reports/renderPdf";
import { buildInvoiceHtml } from "../financials/invoicePdf";
```

and the route:

```typescript
  /**
   * Issue an invoice for one client's month.
   *
   * The number is allocated inside a transaction, because two invoices
   * sharing a number is a problem a client's accountant discovers, not you.
   */
  app.post<{ Body: { clientId: string; month: string } }>(
    "/financials/invoices",
    async (request, reply) => {
      const agencyId = request.user.agencyId;
      const { clientId, month } = request.body;
      if (!monthKeySchema.safeParse(month).success) {
        return reply.status(400).send({ error: "month must be YYYY-MM" });
      }

      const entry = await prisma.revenueEntry.findUnique({
        where: { clientId_month: { clientId, month } },
      });
      if (!entry || entry.agencyId !== agencyId) return reply.status(404).send(NOT_FOUND);

      const [client, agency] = await Promise.all([
        prisma.client.findFirst({
          where: { id: clientId, agencyId, deletedAt: null },
          select: { name: true, contactName: true, contactEmail: true },
        }),
        prisma.agency.findUnique({
          where: { id: agencyId },
          select: { name: true, legalName: true, ein: true },
        }),
      ]);
      if (!client || !agency) return reply.status(404).send(NOT_FOUND);

      const start = monthStart(month);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);

      const delivered = await prisma.mediaAsset.findMany({
        where: { clientId, isRevision: false, createdAt: { gte: start, lte: end } },
        orderBy: { createdAt: "asc" },
        select: { name: true, createdAt: true },
      });
      const lines = delivered.map((d) => ({
        title: d.name,
        publishedAt: d.createdAt.toISOString(),
      }));

      const invoice = await prisma.$transaction(async (tx) => {
        const last = await tx.invoice.findFirst({
          where: { agencyId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        return await tx.invoice.create({
          data: {
            agencyId,
            clientId,
            number: (last?.number ?? 0) + 1,
            periodStart: start,
            periodEnd: end,
            amountCents: entry.amountCents,
            status: "draft",
            lineItems: lines as never,
          },
        });
      });

      const number = String(invoice.number).padStart(3, "0");
      const html = buildInvoiceHtml({
        number,
        issuedAt: invoice.issuedAt.toISOString(),
        periodLabel: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        business: { legalName: agency.legalName ?? agency.name, ein: agency.ein },
        client: {
          name: client.name,
          contactName: client.contactName,
          contactEmail: client.contactEmail,
        },
        amountCents: invoice.amountCents,
        lines,
      });

      const pdf = await renderReportPdf(html, {});
      const storageKey = `${clientId}/invoices/invoice-${number}.pdf`;
      const abs = nodePath.join(env.STORAGE_DIR, storageKey);
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, pdf);
      await prisma.invoice.update({ where: { id: invoice.id }, data: { storageKey } });

      return reply.status(201).send({ id: invoice.id, number, url: `/files/${storageKey}` });
    },
  );
```

- [ ] **Step 3: Add the button**

In `RevenueSection.tsx`, add an `Invoice` button on rows whose status is not `pending`:

```tsx
            {row.status !== "pending" && (
              <button
                className="btn"
                onClick={() => {
                  void api
                    .post<{ url: string }>("/financials/invoices", {
                      clientId: row.clientId,
                      month,
                    })
                    .then((r) => openExternal(fileUrl(r.url)!))
                    .catch((err) => toast.fail(`Could not invoice ${row.clientName}`, err));
                }}
              >
                Invoice
              </button>
            )}
```

Add `month: string` to the component's props and pass `data.month` from the screen, plus the imports `import { api, fileUrl } from "../../lib/api";` and `import { openExternal } from "../../lib/external";`.

- [ ] **Step 4: Verify end to end**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck
```

Click **Invoice** on a client row. Expected: a PDF opens showing invoice 001, the business name, the client's contact details from Settings, the videos delivered that month, and the total. Click again for the same client and expect **002**, since numbers are never reused.

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/desktop assets && git commit -m "feat: client invoice documents"
```

---

## Task 10: Year-end Schedule C export

**Files:**
- Create: `apps/api/src/financials/taxExport.ts`
- Create: `apps/api/src/financials/taxExport.check.ts`
- Modify: `apps/api/src/routes/financials.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/desktop/src/screens/FinancialsScreen.tsx`

**Interfaces:**
- Consumes: `deductibleCents`, `sumCents`, `EXPENSE_CATEGORIES` from Tasks 1 and 2.
- Produces: `groupForScheduleC(expenses: ExportableExpense[]): ScheduleCGroup[]`, `labelFor(key: string): string`, `buildTaxExportHtml(data): string`, `GET /financials/export?year=YYYY`.

- [ ] **Step 1: Write the failing check**

Create `apps/api/src/financials/taxExport.check.ts`:

```typescript
import { groupForScheduleC } from "./taxExport";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const expenses = [
  { name: "Adobe", categoryLine: "software", amountCents: 5999 },
  { name: "Anthropic", categoryLine: "software", amountCents: 14820 },
  { name: "Dinner", categoryLine: "meals", amountCents: 8460 },
  { name: "Internet", categoryLine: "utilities", amountCents: 7900 },
  { name: "Unentered", categoryLine: "software", amountCents: null },
];

const groups = groupForScheduleC(expenses);
const byKey = (k: string) => groups.find((g) => g.key === k)!;

eq(byKey("software").totalCents, 20819, "software sums its entered bills");
eq(byKey("software").deductibleCents, 20819, "software is fully deductible");
eq(byKey("software").items.length, 2, "an unentered bill is not an item");

// The rule with real tax consequences.
eq(byKey("meals").totalCents, 8460, "meals total is what was actually spent");
eq(byKey("meals").deductibleCents, 4230, "only half a meal may be claimed");

eq(byKey("utilities").scheduleCLine, "25", "utilities is line 25");
eq(byKey("software").scheduleCLine, "27a", "software reports under line 27a");

eq(groups.some((g) => g.totalCents === 0), false, "empty categories are omitted");

console.log("taxExport: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "E:/Claude Stuff/Toreroflow/apps/api" && npx tsx src/financials/taxExport.check.ts
```

Expected: FAIL, `Cannot find module './taxExport'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/financials/taxExport.ts`:

```typescript
import { categoryByKey, deductibleCents, EXPENSE_CATEGORIES, sumCents } from "@toreroflow/core";

export interface ExportableExpense {
  name: string;
  categoryLine: string;
  amountCents: number | null;
}

export interface ScheduleCGroup {
  key: string;
  scheduleCLine: string;
  label: string;
  totalCents: number;
  /** What may actually be claimed. Differs from the total for meals only. */
  deductibleCents: number;
  items: Array<{ name: string; amountCents: number }>;
}

/**
 * Groups a year's expenses by their Schedule C line.
 *
 * Unentered bills are excluded rather than counted as zero, because a total
 * that quietly includes an unknown is worse on a tax document than one that
 * is visibly short. Empty categories are omitted so the export lists only
 * lines with something on them.
 */
export function groupForScheduleC(expenses: ExportableExpense[]): ScheduleCGroup[] {
  const groups: ScheduleCGroup[] = [];

  for (const category of EXPENSE_CATEGORIES) {
    const mine = expenses.filter(
      (e) => e.categoryLine === category.key && e.amountCents !== null,
    );
    if (mine.length === 0) continue;

    const totalCents = sumCents(mine.map((e) => e.amountCents));
    groups.push({
      key: category.key,
      scheduleCLine: category.scheduleCLine,
      label: category.label,
      totalCents,
      deductibleCents: deductibleCents(category.key, totalCents),
      items: mine.map((e) => ({ name: e.name, amountCents: e.amountCents! })),
    });
  }

  return groups;
}

/** Kept exported so a caller can label an unknown key without importing core. */
export function labelFor(key: string): string {
  return categoryByKey(key)?.label ?? key;
}
```

- [ ] **Step 4: Chain the check into the API test script**

In `apps/api/package.json`:

```json
    "test": "tsx src/financials/month.check.ts && tsx src/financials/taxExport.check.ts"
```

- [ ] **Step 5: Run it to verify it passes**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm --filter @toreroflow/api test
```

Expected: both checks pass.

- [ ] **Step 6: Add the export endpoint**

In `apps/api/src/routes/financials.ts`, add:

```typescript
  /**
   * The year-end document a CPA works from.
   *
   * Cash basis by default: paid revenue only. If the agency's accounting
   * method is accrual the export includes unpaid revenue and says so on the
   * cover, because the two must never be ambiguous on a tax document.
   */
  app.get<{ Querystring: { year?: string } }>(
    "/financials/export",
    async (request, reply) => {
      const agencyId = request.user.agencyId;
      const year = Number.parseInt(request.query.year ?? "", 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.status(400).send({ error: "year must be a four digit year" });
      }

      const agency = await prisma.agency.findUnique({
        where: { id: agencyId },
        select: {
          name: true,
          legalName: true,
          ein: true,
          businessCode: true,
          accountingMethod: true,
        },
      });
      if (!agency) return reply.status(404).send(NOT_FOUND);

      const prefix = `${year}-`;
      const [expenses, revenue] = await Promise.all([
        prisma.expense.findMany({ where: { agencyId, month: { startsWith: prefix } } }),
        prisma.revenueEntry.findMany({
          where: { agencyId, month: { startsWith: prefix } },
          include: { client: { select: { name: true } } },
        }),
      ]);

      const cashBasis = (agency.accountingMethod ?? "cash") === "cash";
      const countedRevenue = cashBasis ? revenue.filter((r) => r.receivedAt !== null) : revenue;

      const groups = groupForScheduleC(
        expenses.map((e) => ({
          name: e.name,
          categoryLine: e.categoryLine,
          amountCents: e.amountCents,
        })),
      );

      const html = buildTaxExportHtml({
        year,
        business: {
          legalName: agency.legalName ?? agency.name,
          ein: agency.ein,
          businessCode: agency.businessCode,
          accountingMethod: cashBasis ? "Cash" : "Accrual",
        },
        grossReceiptsCents: sumCents(countedRevenue.map((r) => r.amountCents)),
        receiptsByClient: Object.entries(
          countedRevenue.reduce<Record<string, number>>((acc, r) => {
            acc[r.client.name] = (acc[r.client.name] ?? 0) + r.amountCents;
            return acc;
          }, {}),
        ).map(([name, cents]) => ({ name, cents })),
        groups,
      });

      const pdf = await renderReportPdf(html, {});
      const storageKey = `exports/schedule-c-${year}.pdf`;
      const abs = nodePath.join(env.STORAGE_DIR, storageKey);
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, pdf);
      return reply.status(201).send({ url: `/files/${storageKey}`, year });
    },
  );
```

Add this to `apps/api/src/financials/taxExport.ts`:

```typescript
export interface TaxExportData {
  year: number;
  business: {
    legalName: string;
    ein: string | null;
    businessCode: string | null;
    accountingMethod: string;
  };
  grossReceiptsCents: number;
  receiptsByClient: Array<{ name: string; cents: number }>;
  groups: ScheduleCGroup[];
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * The year-end document.
 *
 * Every expense sits under its Schedule C line so a CPA reads the form's own
 * structure rather than translating ours. Where a line's deductible figure
 * differs from what was spent, both are shown and labelled, because a single
 * halved number with no explanation looks like an arithmetic error.
 */
export function buildTaxExportHtml(data: TaxExportData): string {
  const receipts = data.receiptsByClient
    .map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${money(r.cents)}</td></tr>`)
    .join("");

  const groups = data.groups
    .map((g) => {
      const items = g.items
        .map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${money(i.amountCents)}</td></tr>`)
        .join("");
      const split =
        g.deductibleCents !== g.totalCents
          ? `<tr class="tot"><td>Deductible at 50%</td><td class="r">${money(g.deductibleCents)}</td></tr>`
          : "";
      return `<h3>Line ${esc(g.scheduleCLine)} &middot; ${esc(g.label)}</h3>
        <table>${items}
          <tr class="tot"><td>Spent</td><td class="r">${money(g.totalCents)}</td></tr>
          ${split}
        </table>`;
    })
    .join("");

  const totalDeductible = data.groups.reduce((n, g) => n + g.deductibleCents, 0);

  return `<!doctype html><meta charset="utf-8"><title>Schedule C ${data.year}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#111;margin:0;padding:48px 56px}
  h1{font-size:26px;margin:0 0 6px}
  h3{font-size:14px;margin:26px 0 0}
  .muted{color:#777;font-size:13px;line-height:1.7}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  td{padding:7px 0;border-bottom:1px solid #ececec}
  td.r{text-align:right}
  tr.tot td{font-weight:700;border-bottom:2px solid #111}
  .grand{margin-top:30px;padding-top:14px;border-top:2px solid #111;font-size:16px;font-weight:700;
    display:flex;justify-content:space-between}
  .foot{margin-top:36px;font-size:11px;color:#888;line-height:1.7}
</style>
<h1>Schedule C summary, ${data.year}</h1>
<div class="muted">
  ${esc(data.business.legalName)}<br>
  ${data.business.ein ? `EIN ${esc(data.business.ein)}<br>` : "EIN not recorded<br>"}
  ${data.business.businessCode ? `Business code ${esc(data.business.businessCode)}<br>` : "Business code not recorded<br>"}
  Accounting method: ${esc(data.business.accountingMethod)}
</div>

<h3>Gross receipts</h3>
<table>${receipts}
  <tr class="tot"><td>Total</td><td class="r">${money(data.grossReceiptsCents)}</td></tr>
</table>

${groups}

<div class="grand"><span>Total deductible expenses</span><span>${money(totalDeductible)}</span></div>

<div class="foot">
  Generated by Toreroflow on ${new Date().toLocaleDateString("en-US")}. These figures are records
  kept in Toreroflow and are not tax advice. Business meals are reported at the 50% deductible
  rate for 2026. Expenses with no amount recorded are excluded entirely rather than counted as
  zero, so confirm every bill has been entered before filing.
</div>`;
}
```

Import `buildTaxExportHtml` alongside `groupForScheduleC` in the route.

- [ ] **Step 7: Add the button**

In `FinancialsScreen.tsx`, below the sections:

```tsx
        <div className="card glass" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 14.5 }}>Export for taxes</b>
            <div className="sub">
              Every expense grouped by its Schedule C line, gross receipts by client, meals split
              at the deductible 50%, and your business details on the cover.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              void api
                .get<{ url: string }>(`/financials/export?year=${new Date().getFullYear()}`)
                .then((r) => openExternal(fileUrl(r.url)!))
                .catch((err) => toast.fail("Could not build the tax export", err));
            }}
          >
            Export {new Date().getFullYear()}
          </button>
        </div>
```

- [ ] **Step 8: Verify end to end**

```bash
cd "E:/Claude Stuff/Toreroflow" && pnpm -r typecheck && pnpm --filter @toreroflow/api test && pnpm --filter @toreroflow/core test && pnpm --filter @toreroflow/desktop test
```

Click **Export**. Expected: a PDF with the business details on the cover, gross receipts per client, expense groups by Schedule C line, and any meals showing both the full amount and the halved deductible figure.

- [ ] **Step 9: Commit**

```bash
git add apps/api apps/desktop && git commit -m "feat: year-end Schedule C export"
```

---

## Self-review notes

**Spec coverage.** Section 3.1 to 3.4 is Task 3. Section 3.5 (Agency fields) is Task 3, surfaced by Task 10; **a Settings form for those fields is not in this plan** and the export falls back to the agency name with a blank EIN until one exists. Add it before filing anything real. Section 3.6 palette is Task 6. Section 4 is Task 2, with the meals rule in Tasks 1 and 10. Section 5 screen is Tasks 6 to 8; **the donut and the twelve-month bars are not in this plan** and should be a Task 11 once the data is real. Section 6.1 is Task 9, 6.2 is Task 10. Section 7 testing is covered by the four check files.

**Known gaps, deliberately deferred:**
1. Quota-met derivation in Task 5 is a placeholder that treats untracked clients as met. Wire it to the real quota counts when Task 8 lands, or `pending` will never appear for a genuinely behind client.
2. No donut or bar chart yet, so the screen is tiles plus lists.
3. No Settings form for the agency's legal name, EIN or business code.
