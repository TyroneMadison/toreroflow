# Financials Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the six never-implemented Financials sections (Net card, donut, At a glance, twelve-month bars, Money coming out, One-off expenses), make revenue amounts editable per month, move permanent prices to Settings, and give the screen honest loading and error states, per `docs/superpowers/specs/2026-07-27-financials-completion-design.md`.

**Architecture:** Pure month-series math lives in a new `apps/api/src/financials/summary.ts` with a runnable check; the `GET /financials` route gains `series`, `ytd`, `years`, and per-row quota fields; a new `DELETE /financials/revenue/:id` lands beside the expense delete. The desktop gains four presentational cards fed by the month payload, one shared `ExpenseSection` for both expense kinds, an upgraded `RevenueSection`, and a rewritten `FinancialsScreen` with a load-phase state machine. Charts are hand-rolled SVG/CSS ported from the signed-off mockup `storage/preview/financials.html`.

**Tech Stack:** React 18 + TypeScript (Vite) in apps/desktop, Fastify + Prisma in apps/api, zod schemas in packages/core. No new dependencies.

## Global Constraints

- The repo has **no test framework and must not gain one**. Checks are `.check.ts` files run under `tsx` via each package's `test` script.
- **No em dashes** anywhere in copy, comments, or docs. Use commas, periods, or hyphens.
- **No AI attribution in commits.** Lowercase `fix:`/`feat:`/`docs:` prefixes, plain sentences.
- Money is integer cents everywhere. Dollars exist only inside input fields; convert with `Math.round(dollars * 100)` exactly once at the edge.
- A null expense amount means "bill not entered", never zero. Null amounts are excluded from sums and counted in `missingBills`.
- The mockup's "Add income" affordance is deliberately NOT built: `RevenueEntry` requires a client, and client-less income is a schema change. Recorded here so nobody mistakes it for an oversight.
- The month screen's income basis is all revenue rows (paid or not), matching the existing `totals.inCents`. The series and YTD numbers use the same basis so the screen never disagrees with itself.
- Chart CSS must be scoped under `.chartcard` because `.col`, `.cap`, and `.fill`-like names are already used by the Calendar screen's CSS.
- Typecheck command per package: `pnpm --filter @toreroflow/api typecheck`, `pnpm --filter @toreroflow/desktop typecheck`. Checks: `pnpm --filter @toreroflow/api test`, `pnpm --filter @toreroflow/desktop test`.

---

### Task 1: Pure month-series math with a check

**Files:**
- Create: `apps/api/src/financials/summary.ts`
- Create: `apps/api/src/financials/summary.check.ts`
- Modify: `apps/api/package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces: `monthKeysEnding(end: string, count: number): string[]`, `buildSeries(end: string, revenue: MonthCents[], expenses: MonthMaybeCents[], count?: number): SeriesPoint[]`, `ytdTotals(month: string, revenue: MonthCents[], expenses: MonthMaybeCents[]): { inCents: number; netCents: number }` where `MonthCents = { month: string; amountCents: number }`, `MonthMaybeCents = { month: string; amountCents: number | null }`, `SeriesPoint = { month: string; inCents: number; outCents: number }`. Task 2 imports all three functions.

- [ ] **Step 1: Write the check first**

`apps/api/src/financials/summary.check.ts`:

```ts
import assert from "node:assert/strict";
import { buildSeries, monthKeysEnding, ytdTotals } from "./summary";

// Twelve keys ending at the requested month, crossing the year boundary.
const keys = monthKeysEnding("2026-02", 12);
assert.equal(keys.length, 12);
assert.equal(keys[0], "2025-03");
assert.equal(keys[11], "2026-02");

// Months with no rows are zero, not missing; null amounts are excluded.
const series = buildSeries(
  "2026-02",
  [
    { month: "2026-01", amountCents: 150000 },
    { month: "2026-01", amountCents: 50000 },
    { month: "2026-02", amountCents: 150000 },
  ],
  [
    { month: "2026-01", amountCents: 5999 },
    { month: "2026-02", amountCents: null },
    { month: "2026-02", amountCents: 7900 },
  ],
);
assert.equal(series.length, 12);
assert.deepEqual(series[10], { month: "2026-01", inCents: 200000, outCents: 5999 });
assert.deepEqual(series[11], { month: "2026-02", inCents: 150000, outCents: 7900 });
assert.deepEqual(series[0], { month: "2025-03", inCents: 0, outCents: 0 });

// YTD counts only the requested year up to and including the month.
const ytd = ytdTotals(
  "2026-02",
  [
    { month: "2025-12", amountCents: 999999 },
    { month: "2026-01", amountCents: 200000 },
    { month: "2026-02", amountCents: 150000 },
    { month: "2026-03", amountCents: 888888 },
  ],
  [
    { month: "2026-01", amountCents: 5999 },
    { month: "2026-02", amountCents: null },
  ],
);
assert.equal(ytd.inCents, 350000);
assert.equal(ytd.netCents, 350000 - 5999);

console.log("summary: all checks passed");
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @toreroflow/api exec tsx src/financials/summary.check.ts`
Expected: FAIL, cannot find module `./summary`.

- [ ] **Step 3: Implement**

`apps/api/src/financials/summary.ts`:

```ts
/**
 * Pure assembly of the twelve-month series and year-to-date totals.
 *
 * Kept out of the route so the money math can be checked without a
 * database. Null expense amounts are bills not yet entered; they are
 * excluded from every sum here and surfaced through missingBills on the
 * month payload instead, so an unknown bill can never read as free.
 */

export interface MonthCents {
  month: string;
  amountCents: number;
}

export interface MonthMaybeCents {
  month: string;
  amountCents: number | null;
}

export interface SeriesPoint {
  month: string;
  inCents: number;
  outCents: number;
}

/** The `count` month keys ending at `end`, oldest first. */
export function monthKeysEnding(end: string, count: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(y!, m! - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function buildSeries(
  end: string,
  revenue: MonthCents[],
  expenses: MonthMaybeCents[],
  count = 12,
): SeriesPoint[] {
  const keys = monthKeysEnding(end, count);
  const inBy = new Map<string, number>();
  for (const r of revenue) inBy.set(r.month, (inBy.get(r.month) ?? 0) + r.amountCents);
  const outBy = new Map<string, number>();
  for (const e of expenses) {
    if (e.amountCents === null) continue;
    outBy.set(e.month, (outBy.get(e.month) ?? 0) + e.amountCents);
  }
  return keys.map((month) => ({
    month,
    inCents: inBy.get(month) ?? 0,
    outCents: outBy.get(month) ?? 0,
  }));
}

/** Totals for the requested month's year, from January up to that month. */
export function ytdTotals(
  month: string,
  revenue: MonthCents[],
  expenses: MonthMaybeCents[],
): { inCents: number; netCents: number } {
  const year = month.slice(0, 4);
  const counted = (m: string) => m.startsWith(`${year}-`) && m <= month;
  let inCents = 0;
  for (const r of revenue) if (counted(r.month)) inCents += r.amountCents;
  let outCents = 0;
  for (const e of expenses) {
    if (e.amountCents !== null && counted(e.month)) outCents += e.amountCents;
  }
  return { inCents, netCents: inCents - outCents };
}
```

- [ ] **Step 4: Run the check, then chain it into the test script**

Run: `pnpm --filter @toreroflow/api exec tsx src/financials/summary.check.ts`
Expected: `summary: all checks passed`

In `apps/api/package.json`, extend the `test` script from

```json
"test": "tsx src/financials/month.check.ts && tsx src/financials/taxExport.check.ts"
```

to

```json
"test": "tsx src/financials/month.check.ts && tsx src/financials/taxExport.check.ts && tsx src/financials/summary.check.ts"
```

Run: `pnpm --filter @toreroflow/api test`
Expected: three "all checks passed" lines.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/financials/summary.ts apps/api/src/financials/summary.check.ts apps/api/package.json
git commit -m "feat: pure twelve-month series and YTD math for financials"
```

---

### Task 2: API month payload grows series, ytd, years, and quota fields; revenue delete route

**Files:**
- Modify: `apps/api/src/routes/financials.ts`

**Interfaces:**
- Consumes: `monthKeysEnding`, `buildSeries`, `ytdTotals` from Task 1.
- Produces, on `GET /financials`: `series: SeriesPoint[]` (twelve points, oldest first), `ytd: { inCents, netCents }`, `years: number[]` (newest first, current server year down to the earliest opened month's year), and on every revenue row: `billingMode: "calendar" | "on_fulfilment"`, `quotaMet: boolean`, `quotaDelivered: number | null`, `quotaTarget: number | null` (both null when the client tracks no quota). Also `DELETE /financials/revenue/:id` returning `{ ok: true }`. Tasks 3, 5, 7 consume these.

- [ ] **Step 1: Import the new module**

At the top of `apps/api/src/routes/financials.ts`, extend the import block:

```ts
import { deriveStatus, rollForward } from "../financials/month";
import { buildSeries, monthKeysEnding, ytdTotals } from "../financials/summary";
```

- [ ] **Step 2: Return quota counts and billing mode on each revenue row**

Inside the `GET /financials` handler, replace the `revenueRows` mapping (currently `const revenueRows = revenue.map((r) => { ... });`) with:

```ts
    const revenueRows = revenue.map((r) => {
      const c = byClient.get(r.clientId);
      // Met means every tracked format has reached its target. A client with
      // no targets at all counts as met, because there is nothing to wait for.
      const d = deliveredByClient.get(r.clientId) ?? { short: 0, long: 0 };
      const quotaMet =
        !c ||
        ((c.quotaShort == null || d.short >= c.quotaShort) &&
          (c.quotaLong == null || d.long >= c.quotaLong));
      // Delivered and target summed over tracked formats only, so an
      // untracked format neither inflates nor blocks the fraction shown
      // beside the row. Both null when nothing is tracked.
      const hasTargets = c != null && (c.quotaShort != null || c.quotaLong != null);
      const quotaTarget = hasTargets ? (c.quotaShort ?? 0) + (c.quotaLong ?? 0) : null;
      const quotaDelivered = hasTargets
        ? (c.quotaShort != null ? d.short : 0) + (c.quotaLong != null ? d.long : 0)
        : null;
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
        billingMode: (c?.billingMode ?? "calendar") as "calendar" | "on_fulfilment",
        quotaMet,
        quotaDelivered,
        quotaTarget,
        status: deriveStatus({
          receivedAt: r.receivedAt,
          billingMode: c?.billingMode ?? "calendar",
          quotaMet,
        }),
      };
    });
```

- [ ] **Step 3: Assemble series, ytd, and years, and return them**

Still inside the handler, replace the block from `const recurring = expenses.filter(...)` through the final `return { ... };` with:

```ts
    const recurring = expenses.filter((e) => e.kind === "recurring");
    const oneOff = expenses.filter((e) => e.kind === "one_off");

    // Twelve months of history for the bars, sparkline, and delta. The
    // window always contains January-to-now of the requested month's year,
    // so the YTD numbers reuse the same two queries.
    const windowKeys = monthKeysEnding(month, 12);
    const [windowRevenue, windowExpenses] = await Promise.all([
      prisma.revenueEntry.findMany({
        where: { agencyId, month: { in: windowKeys } },
        select: { month: true, amountCents: true },
      }),
      prisma.expense.findMany({
        where: { agencyId, month: { in: windowKeys } },
        select: { month: true, amountCents: true },
      }),
    ]);
    const series = buildSeries(month, windowRevenue, windowExpenses);
    const ytd = ytdTotals(month, windowRevenue, windowExpenses);

    // Years the export selector can offer: from the earliest opened month's
    // year up to the server's current year, newest first.
    const firstOpened = await prisma.financialMonth.findFirst({
      where: { agencyId },
      orderBy: { month: "asc" },
      select: { month: true },
    });
    const nowYear = new Date().getFullYear();
    const firstYear = firstOpened ? Number(firstOpened.month.slice(0, 4)) : nowYear;
    const years: number[] = [];
    for (let y = nowYear; y >= Math.min(firstYear, nowYear); y--) years.push(y);

    return {
      month,
      categories: EXPENSE_CATEGORIES,
      revenue: revenueRows,
      recurring,
      oneOff,
      series,
      ytd,
      years,
      totals: {
        inCents: sumCents(revenueRows.map((r) => r.amountCents)),
        recurringOutCents: sumCents(recurring.map((e) => e.amountCents)),
        oneOffOutCents: sumCents(oneOff.map((e) => e.amountCents)),
        // Unknown bills are excluded from the total and reported separately so
        // the screen can say the figure is incomplete rather than pretend.
        missingBills: expenses.filter((e) => e.amountCents === null).length,
      },
    };
```

- [ ] **Step 4: Add the revenue delete route**

Directly after the `PATCH /financials/revenue/:id` route, add:

```ts
  app.delete<{ Params: { id: string } }>("/financials/revenue/:id", async (request, reply) => {
    const found = await prisma.revenueEntry.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    await prisma.revenueEntry.delete({ where: { id: found.id } });
    return { ok: true };
  });
```

- [ ] **Step 5: Typecheck and check**

Run: `pnpm --filter @toreroflow/api typecheck`
Expected: exit 0.
Run: `pnpm --filter @toreroflow/api test`
Expected: three "all checks passed" lines.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/financials.ts
git commit -m "feat: month payload gains series, ytd, years, quota fields, and a revenue delete route"
```

---

### Task 3: Desktop finance lib: new types, donut and sparkline math, check

**Files:**
- Modify: `apps/desktop/src/lib/financials.ts`
- Create: `apps/desktop/src/lib/financials.check.ts`
- Modify: `apps/desktop/package.json` (test script)

**Interfaces:**
- Consumes: the Task 2 payload shape.
- Produces: extended `RevenueRow` (adds `billingMode`, `quotaMet`, `quotaDelivered`, `quotaTarget`), `SeriesPoint`, extended `FinancialsMonth` (adds `series`, `ytd`, `years`), `donutSegments(parts: Array<{ cents: number; color: string }>): Array<{ color: string; pct: number; dasharray: string; dashoffset: number }>`, `sparkPath(values: number[], width: number, height: number): { line: string; area: string }`. Tasks 4, 5, 7 consume these.

- [ ] **Step 1: Write the check first**

`apps/desktop/src/lib/financials.check.ts`:

```ts
import assert from "node:assert/strict";
import { donutSegments, sparkPath } from "./financials";

// Segments sum to 100 percent and walk clockwise from 12 o'clock. The SVG
// circle has circumference 100, first offset 25, each next offset minus the
// arcs before it, matching the signed-off mockup's numbers.
const segs = donutSegments([
  { cents: 150000, color: "#57d6a0" },
  { cents: 120000, color: "#4ea8ff" },
  { cents: 85000, color: "#8b7bff" },
]);
assert.equal(segs.length, 3);
const total = segs.reduce((a, s) => a + s.pct, 0);
assert.ok(Math.abs(total - 100) < 0.01, `pcts sum to ${total}`);
assert.equal(segs[0]!.dashoffset, 25);
assert.ok(Math.abs(segs[1]!.dashoffset - (25 - segs[0]!.pct)) < 0.01);
assert.ok(Math.abs(segs[2]!.dashoffset - (25 - segs[0]!.pct - segs[1]!.pct)) < 0.01);

// Zero total produces no segments rather than NaN.
assert.deepEqual(donutSegments([{ cents: 0, color: "#fff" }]), []);

// Sparkline: flat-zero input stays on the baseline with no NaN anywhere.
const flat = sparkPath([0, 0, 0], 220, 54);
assert.ok(!flat.line.includes("NaN"));
assert.ok(!flat.area.includes("NaN"));

// Rising input ends higher (smaller y) than it starts.
const rise = sparkPath([100, 200, 400], 220, 54);
const ys = rise.line
  .split("L")
  .map((p) => Number(p.replace("M", "").trim().split(" ")[1]));
assert.ok(ys[ys.length - 1]! < ys[0]!);

console.log("financials lib: all checks passed");
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @toreroflow/desktop exec tsx src/lib/financials.check.ts`
Expected: FAIL, `donutSegments` is not exported.

- [ ] **Step 3: Extend the lib**

In `apps/desktop/src/lib/financials.ts`, extend `RevenueRow` with the new fields (after `receivedAt`):

```ts
  receivedAt: string | null;
  status: "paid" | "pending" | "due";
  billingMode: "calendar" | "on_fulfilment";
  quotaMet: boolean;
  /** Null when the client tracks no quota. */
  quotaDelivered: number | null;
  quotaTarget: number | null;
```

Add after `ExpenseRow`:

```ts
export interface SeriesPoint {
  month: string;
  inCents: number;
  outCents: number;
}
```

Extend `FinancialsMonth` (after `oneOff`):

```ts
  oneOff: ExpenseRow[];
  /** Twelve months ending at `month`, oldest first. */
  series: SeriesPoint[];
  ytd: { inCents: number; netCents: number };
  /** Years the export selector offers, newest first. */
  years: number[];
```

Append at the end of the file:

```ts
/**
 * Donut arcs for an SVG circle of circumference 100.
 *
 * The first arc starts at 12 o'clock (offset 25 in SVG dash space) and each
 * following arc starts where the previous ended. A zero total returns no
 * segments so the chart shows only the track ring, never NaN.
 */
export function donutSegments(
  parts: Array<{ cents: number; color: string }>,
): Array<{ color: string; pct: number; dasharray: string; dashoffset: number }> {
  const total = parts.reduce((a, p) => a + p.cents, 0);
  if (total <= 0) return [];
  let consumed = 0;
  return parts
    .filter((p) => p.cents > 0)
    .map((p) => {
      const pct = (p.cents / total) * 100;
      const seg = {
        color: p.color,
        pct,
        dasharray: `${pct.toFixed(2)} ${(100 - pct).toFixed(2)}`,
        dashoffset: Number((25 - consumed).toFixed(2)),
      };
      consumed += pct;
      return seg;
    });
}

/**
 * A sparkline path pair for an SVG viewBox of the given size.
 *
 * `line` is the stroke, `area` the same path closed along the bottom for the
 * gradient fill. Values map linearly with a small top and bottom margin; a
 * flat series (all equal, including all zero) draws along the baseline.
 */
export function sparkPath(
  values: number[],
  width: number,
  height: number,
): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const top = 6;
  const bottom = height - 6;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const y = span === 0 ? bottom : bottom - ((v - min) / span) * (bottom - top);
    return `${(i * step).toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return { line, area };
}
```

- [ ] **Step 4: Run the check, chain it into the test script**

Run: `pnpm --filter @toreroflow/desktop exec tsx src/lib/financials.check.ts`
Expected: `financials lib: all checks passed`

In `apps/desktop/package.json`, extend the `test` script from

```json
"test": "tsx src/lib/viewTiers.check.ts"
```

to

```json
"test": "tsx src/lib/viewTiers.check.ts && tsx src/lib/financials.check.ts"
```

Run: `pnpm --filter @toreroflow/desktop test`
Expected: two "all checks passed" lines.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0. (Nothing consumes the new fields yet; the extended `RevenueRow` matches what the API now returns.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/financials.ts apps/desktop/src/lib/financials.check.ts apps/desktop/package.json
git commit -m "feat: finance lib types for series and quota plus donut and sparkline math"
```

---

### Task 4: The four presentational cards and their CSS

**Files:**
- Create: `apps/desktop/src/components/finance/NetCard.tsx`
- Create: `apps/desktop/src/components/finance/DonutCard.tsx`
- Create: `apps/desktop/src/components/finance/GlanceCard.tsx`
- Create: `apps/desktop/src/components/finance/MonthBars.tsx`
- Modify: `apps/desktop/src/styles.css` (append to the Financials block after the `.cwrap .sw.on` rules)

**Interfaces:**
- Consumes: `SeriesPoint`, `donutSegments`, `sparkPath`, `colorFor` from Task 3; `formatCents` from `@toreroflow/core`.
- Produces: `<NetCard series />`, `<DonutCard rows totalCents />` (rows are `RevenueRow[]`), `<GlanceCard totals ytd />`, `<MonthBars series />`. Task 7 mounts all four.

- [ ] **Step 1: NetCard**

`apps/desktop/src/components/finance/NetCard.tsx`:

```tsx
import { formatCents } from "@toreroflow/core";
import { sparkPath, type SeriesPoint } from "../../lib/financials";

/** Month key "2026-06" to a short label like "May". */
function shortMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString("en-US", { month: "short" });
}

/**
 * Net this month, with the change against the prior month and a sparkline
 * of the last twelve nets. The delta is a dash when the prior month has no
 * activity, because a percentage against nothing is noise.
 */
export default function NetCard({ series }: { series: SeriesPoint[] }) {
  const nets = series.map((p) => p.inCents - p.outCents);
  const current = nets[nets.length - 1] ?? 0;
  const prev = nets.length > 1 ? nets[nets.length - 2]! : null;
  const prevActive =
    prev !== null &&
    series.length > 1 &&
    (series[series.length - 2]!.inCents !== 0 || series[series.length - 2]!.outCents !== 0);
  const deltaPct = prevActive && prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : null;
  const prevLabel = series.length > 1 ? shortMonth(series[series.length - 2]!.month) : "";
  const { line, area } = sparkPath(nets, 220, 54);

  return (
    <div className="netcard glass">
      <div className="lbl">Net this month</div>
      <div className="big">{formatCents(current)}</div>
      <div style={{ marginTop: 9 }}>
        {deltaPct === null ? (
          <span className="chip flat">-</span>
        ) : (
          <span className={`chip ${deltaPct >= 0 ? "up" : "down"}`}>
            {deltaPct >= 0 ? "+" : ""}
            {deltaPct.toFixed(1)}%
          </span>
        )}{" "}
        <span className="chipnote">vs {prevLabel}</span>
      </div>
      <div className="spark">
        <svg viewBox="0 0 220 54" width="100%" height="54" preserveAspectRatio="none">
          <defs>
            <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#57d6a0" stopOpacity=".38" />
              <stop offset="100%" stopColor="#57d6a0" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={line} fill="none" stroke="#57d6a0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d={area} fill="url(#sparkfill)" />
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: DonutCard**

`apps/desktop/src/components/finance/DonutCard.tsx`:

```tsx
import { formatCents } from "@toreroflow/core";
import { colorFor, donutSegments, type RevenueRow } from "../../lib/financials";

/**
 * Where the month's income comes from: one donut arc and one track bar per
 * client, both in the row's chosen colour so the whole screen reads the
 * same. With no income the ring is just the empty track.
 */
export default function DonutCard({ rows, totalCents }: { rows: RevenueRow[]; totalCents: number }) {
  const parts = rows.map((r, i) => ({ cents: r.amountCents, color: colorFor(r.color, i) }));
  const segs = donutSegments(parts);

  return (
    <div className="donutcard glass">
      <div className="dwrap">
        <svg width="146" height="146" viewBox="0 0 42 42">
          <circle cx="21" cy="21" r="15.9" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="4.4" />
          {segs.map((s, i) => (
            <circle
              key={i}
              cx="21"
              cy="21"
              r="15.9"
              fill="none"
              stroke={s.color}
              strokeWidth="4.4"
              strokeDasharray={s.dasharray}
              strokeDashoffset={s.dashoffset}
              strokeLinecap="round"
            />
          ))}
        </svg>
        <div className="dctr">
          <small>Money in</small>
          <b>{formatCents(totalCents)}</b>
        </div>
      </div>
      <div className="dbars">
        {rows.length === 0 && <div className="chipnote">No income this month yet.</div>}
        {rows.map((r, i) => {
          const pct = totalCents > 0 ? (r.amountCents / totalCents) * 100 : 0;
          const color = colorFor(r.color, i);
          return (
            <div className="db" key={r.id}>
              <div className="dtop">
                <i style={{ background: color }} /> {r.clientName} <b>{formatCents(r.amountCents)}</b>
              </div>
              <div className="track">
                <i style={{ width: `${pct.toFixed(1)}%`, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: GlanceCard**

`apps/desktop/src/components/finance/GlanceCard.tsx`:

```tsx
import { formatCents } from "@toreroflow/core";
import type { FinancialsMonth } from "../../lib/financials";

/** The month and the year, five numbers, no chart. */
export default function GlanceCard({
  totals,
  ytd,
}: {
  totals: FinancialsMonth["totals"];
  ytd: FinancialsMonth["ytd"];
}) {
  return (
    <div className="actcard glass">
      <div className="act"><span>Money in</span><b className="g">{formatCents(totals.inCents)}</b></div>
      <div className="act"><span>Recurring out</span><b className="r">{formatCents(totals.recurringOutCents)}</b></div>
      <div className="act"><span>One-off out</span><b className="r">{formatCents(totals.oneOffOutCents)}</b></div>
      <div className="act"><span>This year in</span><b>{formatCents(ytd.inCents)}</b></div>
      <div className="act"><span>This year net</span><b>{formatCents(ytd.netCents)}</b></div>
    </div>
  );
}
```

- [ ] **Step 4: MonthBars**

`apps/desktop/src/components/finance/MonthBars.tsx`:

```tsx
import { useState } from "react";
import { formatCents } from "@toreroflow/core";
import type { SeriesPoint } from "../../lib/financials";

function shortMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString("en-US", { month: "short" });
}

/** Round up to a clean axis ceiling: 1, 2, 2.5, 5, 10 times a power of ten. */
function niceCeil(cents: number): number {
  if (cents <= 0) return 100000;
  const raw = cents / 100;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (raw <= mult * pow) return Math.round(mult * pow * 100);
  }
  return Math.round(10 * pow * 100);
}

function axisLabel(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 1000 ? `$${(dollars / 1000).toFixed(dollars % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(dollars)}`;
}

/**
 * The last twelve months, one bar each. Bar height is income, the red slice
 * is cost, the green slice is what was kept. The hovered or current month
 * shows the exact figures. Cost above income still draws inside the income
 * bar; the callout carries the real numbers.
 */
export default function MonthBars({ series }: { series: SeriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceCeil(Math.max(...series.map((p) => p.inCents), 1));
  const active = hover ?? series.length - 1;
  const labels = [max, (max * 3) / 4, max / 2, max / 4, 0];

  return (
    <div className="card glass chartcard">
      <div className="rowhead">
        <div>
          <h3>Last twelve months</h3>
          <div className="sub">Each bar is what came in. Red is what it cost you, green is what you kept.</div>
        </div>
      </div>
      <div className="chartwrap">
        <div className="yaxis">
          {labels.map((v, i) => (
            <span key={i}>{axisLabel(v)}</span>
          ))}
        </div>
        <div className="chart">
          {series.map((p, i) => {
            const totalPct = (p.inCents / max) * 100;
            const costPct = (Math.min(p.outCents, p.inCents) / max) * 100;
            const keptPct = Math.max(totalPct - costPct, 0);
            return (
              <div
                className={`col${i === active ? " on" : ""}`}
                key={p.month}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {i === active && (
                  <div className="tip">
                    {formatCents(p.inCents)} in · {formatCents(p.outCents)} out
                  </div>
                )}
                <div className="tk">
                  {costPct > 0 && <div className="fill o" style={{ height: `${costPct.toFixed(1)}%` }} />}
                  {keptPct > 0 && <div className="fill i" style={{ height: `${keptPct.toFixed(1)}%` }} />}
                </div>
                <div className="cap">{shortMonth(p.month)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Append the CSS**

In `apps/desktop/src/styles.css`, after the `.cwrap .sw.on` rules of the Financials block, append:

```css
/* Financials top band: net + donut + at a glance, per the signed-off mockup. */
.band{display:grid;grid-template-columns:1fr 1.5fr 1fr;gap:14px;margin-bottom:14px}
.netcard{padding:22px;display:flex;flex-direction:column}
.netcard .lbl{font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt-3);font-weight:600}
.netcard .big{font-size:36px;font-weight:700;letter-spacing:-1px;margin-top:10px;
  background:linear-gradient(135deg,#eafff6,#57d6a0);-webkit-background-clip:text;background-clip:text;color:transparent}
.chip{font-size:11px;font-weight:650;padding:3px 10px;border-radius:20px}
.chip.up{color:var(--green);background:rgba(87,214,160,.14)}
.chip.down{color:var(--red);background:rgba(255,107,122,.14)}
.chip.flat{color:var(--txt-3);background:var(--glass-2)}
.chipnote{font-size:11.5px;color:var(--txt-3)}
.netcard .spark{margin-top:auto;padding-top:14px}
.donutcard{padding:22px;display:flex;gap:22px;align-items:center}
.dwrap{position:relative;flex:0 0 auto}
.dctr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.dctr small{font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--txt-3);font-weight:600}
.dctr b{font-size:19px;font-weight:700;letter-spacing:-.5px}
.dbars{flex:1;min-width:0;display:flex;flex-direction:column;gap:13px}
.db .dtop{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--txt-2);margin-bottom:6px}
.db .dtop i{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
.db .dtop b{margin-left:auto;color:var(--txt);font-size:12.5px;font-weight:650}
.track{height:7px;border-radius:20px;background:rgba(255,255,255,.07);overflow:hidden}
.track i{display:block;height:100%;border-radius:20px}
.actcard{padding:14px 22px;display:flex;flex-direction:column}
.act{display:flex;align-items:baseline;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--brd-soft)}
.act:last-child{border-bottom:0}
.act span{font-size:12px;color:var(--txt-3)}
.act b{font-size:14.5px;font-weight:650}
.act b.g{color:var(--green)}
.act b.r{color:var(--red)}

/* Twelve-month bars. Everything scoped under .chartcard: .col and .cap are
   already taken by the calendar's CSS. */
.chartcard{padding:22px;margin-bottom:14px}
.chartcard .chartwrap{display:flex;gap:14px;margin-top:4px}
.chartcard .yaxis{display:flex;flex-direction:column;justify-content:space-between;height:196px;padding-bottom:24px;flex:0 0 auto}
.chartcard .yaxis span{font-size:10px;color:var(--txt-3)}
.chartcard .chart{flex:1;display:flex;align-items:flex-end;gap:12px;height:196px}
.chartcard .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:9px;height:100%;position:relative}
.chartcard .tk{flex:1;width:100%;max-width:46px;border-radius:14px;background:rgba(255,255,255,.055);
  display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;padding:4px;gap:3px}
.chartcard .fill{width:100%;border-radius:11px}
.chartcard .fill.i{background:linear-gradient(180deg,#6fe3b0,#3fae80)}
.chartcard .fill.o{background:linear-gradient(180deg,#ff8b97,#c9505f)}
.chartcard .cap{font-size:10.5px;color:var(--txt-3)}
.chartcard .col.on .cap{color:var(--txt);font-weight:600}
.chartcard .col.on .tk{background:rgba(255,255,255,.10);box-shadow:inset 0 0 0 1px rgba(255,255,255,.13)}
.chartcard .tip{position:absolute;top:-6px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:11px;font-weight:650;
  padding:5px 11px;border-radius:10px;background:rgba(14,13,26,.96);border:1px solid var(--brd);box-shadow:0 10px 26px rgba(0,0,0,.55);z-index:5}
[data-theme="light"] .chartcard .tip{background:rgba(248,249,255,.98);box-shadow:0 10px 26px rgba(50,55,110,.25)}
[data-theme="light"] .chartcard .tk{background:rgba(20,22,50,.06)}
[data-theme="light"] .track{background:rgba(20,22,50,.08)}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0. (The cards are not mounted yet; that is Task 7.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/finance/NetCard.tsx apps/desktop/src/components/finance/DonutCard.tsx apps/desktop/src/components/finance/GlanceCard.tsx apps/desktop/src/components/finance/MonthBars.tsx apps/desktop/src/styles.css
git commit -m "feat: net, donut, at a glance, and twelve-month bar cards for financials"
```

---

### Task 5: RevenueSection: inline amount edit, quota display, delete, invoice gating

**Files:**
- Modify: `apps/desktop/src/components/finance/RevenueSection.tsx`
- Modify: `apps/desktop/src/styles.css` (append)

**Interfaces:**
- Consumes: extended `RevenueRow` from Task 3, `DELETE /financials/revenue/:id` from Task 2.
- Produces: the upgraded section Task 7 mounts unchanged (same props: `rows`, `totalCents`, `month`, `onChanged`).

- [ ] **Step 1: Rework the row rendering**

In `apps/desktop/src/components/finance/RevenueSection.tsx`:

Add state and handlers after the existing `const [drafts, setDrafts] = useState...` line:

```tsx
  // Inline edit of one row's amount for this month only. The standing price
  // in Settings is untouched; future months seed from that, not from this.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  // Two-step delete: first click arms, second click within the window fires.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
```

Add the handlers after `setColor`:

```tsx
  const startAmountEdit = (row: RevenueRow) => {
    setEditingId(row.id);
    setAmountDraft((row.amountCents / 100).toFixed(2));
  };

  const commitAmount = async (row: RevenueRow) => {
    const dollars = Number.parseFloat(amountDraft);
    setEditingId(null);
    if (!Number.isFinite(dollars) || dollars < 0) return;
    const cents = Math.round(dollars * 100);
    if (cents === row.amountCents) return;
    try {
      await api.patch(`/financials/revenue/${row.id}`, { amountCents: cents });
      onChanged();
    } catch (err) {
      toast.fail(`Could not change the amount for ${row.clientName}`, err);
    }
  };

  const removeRow = async (row: RevenueRow) => {
    if (confirmingId !== row.id) {
      setConfirmingId(row.id);
      window.setTimeout(() => setConfirmingId((c) => (c === row.id ? null : c)), 2500);
      return;
    }
    setConfirmingId(null);
    try {
      await api.del(`/financials/revenue/${row.id}`);
      onChanged();
    } catch (err) {
      toast.fail(`Could not remove ${row.clientName}'s row`, err);
    }
  };
```

Replace the row JSX inside `rows.map((row, i) => (...))` so the full map reads:

```tsx
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
            {row.quotaTarget !== null && (
              <div className={`quota${(row.quotaDelivered ?? 0) >= row.quotaTarget ? " ok" : ""}`}>
                <b>
                  {row.quotaDelivered}/{row.quotaTarget}
                </b>
                delivered
              </div>
            )}
            {editingId === row.id ? (
              <div className="pricein">
                <span>$</span>
                <input
                  className="field-in"
                  type="number"
                  min="0"
                  step="0.01"
                  autoFocus
                  value={amountDraft}
                  onChange={(e) => setAmountDraft(e.target.value)}
                  onBlur={() => void commitAmount(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              </div>
            ) : (
              <div
                className="amt i editable"
                title="Click to change this month's amount"
                onClick={() => startAmountEdit(row)}
              >
                {formatCents(row.amountCents)}
              </div>
            )}
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
            {row.billingMode === "on_fulfilment" && row.quotaMet && (
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
            <button
              className={`del${confirmingId === row.id ? " arm" : ""}`}
              title={confirmingId === row.id ? "Click again to remove" : "Remove this month's row"}
              onClick={() => void removeRow(row)}
            >
              {confirmingId === row.id ? "SURE?" : "✕"}
            </button>
          </div>
        ))
```

Also update the section subtitle so the new affordance is discoverable. In the `rowhead`, change

```tsx
          <div className="sub">Click the tag to mark a month paid.</div>
```

to

```tsx
          <div className="sub">Click the tag to mark a month paid, click the amount to change it.</div>
```

- [ ] **Step 2: Append the row CSS**

In `apps/desktop/src/styles.css`, append to the Financials block:

```css
/* Revenue and expense row extras: quota fraction, editable amount, delete. */
.quota{font-size:10px;color:var(--txt-3);flex:0 0 auto;text-align:right;min-width:52px;white-space:nowrap;line-height:1.35}
.quota b{display:block;font-size:11.5px;color:var(--txt-2);font-weight:650}
.quota.ok b{color:var(--green)}
.amt.editable{cursor:pointer;border-bottom:1px dashed rgba(255,255,255,.25)}
.amt.editable:hover{border-bottom-color:var(--green)}
[data-theme="light"] .amt.editable{border-bottom-color:rgba(20,22,50,.25)}
.del{min-width:26px;height:26px;padding:0 6px;border-radius:9px;display:grid;place-items:center;color:var(--txt-3);
  border:1px solid var(--brd-soft);background:var(--glass);flex:0 0 auto;cursor:pointer;font-size:11px;font-weight:650;
  font-family:var(--font)}
.del.arm{color:#fff;background:rgba(255,107,122,.25);border-color:rgba(255,107,122,.5)}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/finance/RevenueSection.tsx apps/desktop/src/styles.css
git commit -m "feat: editable amounts, quota fractions, delete, and invoice gating on revenue rows"
```

---

### Task 6: ExpenseSection for recurring and one-off costs

**Files:**
- Create: `apps/desktop/src/components/finance/ExpenseSection.tsx`
- Modify: `apps/desktop/src/styles.css` (append)

**Interfaces:**
- Consumes: `ExpenseRow`, `colorFor` from the lib; `ExpenseCategory` and `formatCents` from `@toreroflow/core`; the expense routes from the API (`POST /financials/expenses`, `PATCH /financials/expenses/:id`, `DELETE /financials/expenses/:id`).
- Produces: `<ExpenseSection title sub kind rows categories month totalCents missingCount onChanged />`. Task 7 mounts it twice, `kind="recurring"` and `kind="one_off"`.

- [ ] **Step 1: The component**

`apps/desktop/src/components/finance/ExpenseSection.tsx`:

```tsx
import { useRef, useState } from "react";
import { deductibleCents, formatCents, type ExpenseCategory } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import { colorFor, type ExpenseRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

interface AddDraft {
  name: string;
  categoryLine: string;
  dollars: string;
  variable: boolean;
  incurredOn: string;
}

/**
 * One expense list, recurring or one-off; the two sections share everything
 * but their copy and their add-form fields. An amount left blank stays
 * null, shown as Missing: an unentered bill must never read as free.
 */
export default function ExpenseSection({
  title,
  sub,
  kind,
  rows,
  categories,
  month,
  totalCents,
  missingCount,
  onChanged,
}: {
  title: string;
  sub: string;
  kind: "recurring" | "one_off";
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  month: string;
  totalCents: number;
  missingCount: number;
  onChanged(): void;
}) {
  const toast = useToast();
  const byKey = new Map(categories.map((c) => [c.key, c]));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddDraft>({
    name: "",
    categoryLine: kind === "recurring" ? "software" : "other",
    dollars: "",
    variable: false,
    incurredOn: new Date().toISOString().slice(0, 10),
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Escape unmounts the focused input, and that unmount fires a native blur
  // which would commit the value the user just cancelled. The ref lets the
  // blur handler tell an Escape-driven unmount from a real blur.
  const cancelEdit = useRef(false);

  const dollarsToCents = (raw: string): number | null | undefined => {
    if (raw.trim() === "") return null;
    const dollars = Number.parseFloat(raw);
    if (!Number.isFinite(dollars) || dollars < 0) return undefined;
    return Math.round(dollars * 100);
  };

  const add = async () => {
    if (!draft.name.trim()) return;
    const cents = dollarsToCents(draft.dollars);
    if (cents === undefined) {
      toast.fail("Could not add the expense", new Error("enter a valid amount or leave it blank"));
      return;
    }
    try {
      await api.post("/financials/expenses", {
        name: draft.name.trim(),
        categoryLine: draft.categoryLine,
        amountCents: cents,
        month,
        kind,
        variable: kind === "recurring" ? draft.variable : false,
        incurredOn: kind === "one_off" ? new Date(`${draft.incurredOn}T12:00:00`).toISOString() : null,
      });
      setAdding(false);
      setDraft((d) => ({ ...d, name: "", dollars: "", variable: false }));
      onChanged();
    } catch (err) {
      toast.fail("Could not add the expense", err);
    }
  };

  const commitAmount = async (row: ExpenseRow) => {
    const cents = dollarsToCents(amountDraft);
    setEditingId(null);
    if (cents === undefined) return;
    if (cents === row.amountCents) return;
    try {
      await api.patch(`/financials/expenses/${row.id}`, { amountCents: cents });
      onChanged();
    } catch (err) {
      toast.fail(`Could not change ${row.name}`, err);
    }
  };

  const setCategory = async (row: ExpenseRow, categoryLine: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, { categoryLine });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recategorise ${row.name}`, err);
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

  const remove = async (row: ExpenseRow) => {
    if (confirmingId !== row.id) {
      setConfirmingId(row.id);
      window.setTimeout(() => setConfirmingId((c) => (c === row.id ? null : c)), 2500);
      return;
    }
    setConfirmingId(null);
    try {
      await api.del(`/financials/expenses/${row.id}`);
      onChanged();
    } catch (err) {
      toast.fail(`Could not delete ${row.name}`, err);
    }
  };

  const subLine = (row: ExpenseRow): string => {
    const cat = byKey.get(row.categoryLine);
    const catLabel = cat?.label ?? row.categoryLine;
    if (row.amountCents === null) return `${catLabel} · bill not entered`;
    if (kind === "one_off") {
      const day = row.incurredOn
        ? new Date(row.incurredOn).toLocaleDateString([], { month: "short", day: "numeric" })
        : "";
      if (row.categoryLine === "meals") {
        return `${catLabel}${day ? ` · ${day}` : ""} · 50% deductible, ${formatCents(deductibleCents(row.categoryLine, row.amountCents))} claimable`;
      }
      return `${catLabel}${day ? ` · ${day}` : ""}`;
    }
    return `${catLabel} · ${row.variable ? "varies monthly" : "monthly"}`;
  };

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>{title}</h3>
          <div className="sub">{sub}</div>
        </div>
        <div className="amt o">
          {formatCents(totalCents)}
          {missingCount > 0 ? " +" : ""}
        </div>
      </div>

      {rows.map((row, i) => (
        <div className={`lrow${row.amountCents === null ? " miss" : ""}`} key={row.id}>
          <div className="cat">{byKey.get(row.categoryLine)?.emoji ?? "📌"}</div>
          <div className="lmeta">
            <b>{row.name}</b>
            <span>{subLine(row)}</span>
          </div>
          <select
            className="field-in catpick"
            value={row.categoryLine}
            onChange={(e) => void setCategory(row, e.target.value)}
            title="Schedule C category"
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {row.amountCents === null && editingId !== row.id && <span className="tag miss">Missing</span>}
          {editingId === row.id ? (
            <div className="pricein">
              <span>$</span>
              <input
                className="field-in"
                type="number"
                min="0"
                step="0.01"
                autoFocus
                value={amountDraft}
                onChange={(e) => setAmountDraft(e.target.value)}
                onBlur={() => {
                  if (cancelEdit.current) {
                    cancelEdit.current = false;
                    return;
                  }
                  void commitAmount(row);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    cancelEdit.current = true;
                    setEditingId(null);
                  }
                }}
              />
            </div>
          ) : (
            <div
              className={`amt o editable${row.amountCents === null ? " unknown" : ""}`}
              title="Click to set this month's amount"
              onClick={() => {
                setEditingId(row.id);
                setAmountDraft(row.amountCents === null ? "" : (row.amountCents / 100).toFixed(2));
              }}
            >
              {row.amountCents === null ? "-" : formatCents(row.amountCents)}
            </div>
          )}
          <ColorPicker value={colorFor(row.color, i)} onChange={(c) => void setColor(row, c)} />
          <button
            className={`del${confirmingId === row.id ? " arm" : ""}`}
            title={confirmingId === row.id ? "Click again to delete" : "Delete"}
            onClick={() => void remove(row)}
          >
            {confirmingId === row.id ? "SURE?" : "✕"}
          </button>
        </div>
      ))}

      {adding ? (
        <div className="lrow addform">
          <input
            className="field-in"
            style={{ flex: 1, minWidth: 120 }}
            placeholder={kind === "recurring" ? "e.g. Adobe Creative Cloud" : "e.g. Client dinner"}
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <select
            className="field-in catpick"
            value={draft.categoryLine}
            onChange={(e) => setDraft((d) => ({ ...d, categoryLine: e.target.value }))}
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="pricein">
            <span>$</span>
            <input
              className="field-in"
              type="number"
              min="0"
              step="0.01"
              placeholder="blank = unknown"
              value={draft.dollars}
              onChange={(e) => setDraft((d) => ({ ...d, dollars: e.target.value }))}
            />
          </div>
          {kind === "recurring" ? (
            <label className="varpick">
              <input
                type="checkbox"
                checked={draft.variable}
                onChange={(e) => setDraft((d) => ({ ...d, variable: e.target.checked }))}
              />
              varies monthly
            </label>
          ) : (
            <input
              className="field-in"
              type="date"
              value={draft.incurredOn}
              onChange={(e) => setDraft((d) => ({ ...d, incurredOn: e.target.value }))}
            />
          )}
          <button className="btn" disabled={!draft.name.trim()} onClick={() => void add()}>
            Add
          </button>
          <button className="btn" onClick={() => setAdding(false)}>
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

- [ ] **Step 2: Append the CSS**

In `apps/desktop/src/styles.css`, append to the Financials block:

```css
/* Expense rows: category emoji chip, missing-bill highlight, add affordance. */
.cat{width:34px;height:34px;border-radius:11px;flex:0 0 auto;display:grid;place-items:center;font-size:15px;
  background:var(--glass-2);border:1px solid var(--brd-soft)}
.amt.o{color:var(--red)}
.amt.o.unknown{color:var(--txt-3)}
.lrow.miss{background:rgba(255,107,122,.05);border-radius:12px;padding-left:8px;padding-right:8px}
.tag.miss{color:var(--red);background:rgba(255,107,122,.14);border:1px solid rgba(255,107,122,.3)}
.addrow{display:flex;align-items:center;justify-content:center;gap:9px;padding:12px;margin-top:9px;border-radius:14px;
  border:1px dashed rgba(255,255,255,.17);color:var(--txt-3);font-size:12.5px;font-weight:500;cursor:pointer}
.addrow:hover{color:var(--txt-2);border-color:rgba(255,255,255,.3)}
[data-theme="light"] .addrow{border-color:rgba(20,22,50,.2)}
.catpick{width:auto;max-width:150px;padding:7px 9px;font-size:11.5px;flex:0 0 auto}
.varpick{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--txt-3);flex:0 0 auto;white-space:nowrap}
.addform{flex-wrap:wrap}
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0. (Mounted in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/finance/ExpenseSection.tsx apps/desktop/src/styles.css
git commit -m "feat: expense sections with add, edit, delete, and honest missing bills"
```

---

### Task 7: FinancialsScreen rewrite: compose everything, loading and error states, export year selector

**Files:**
- Modify: `apps/desktop/src/screens/FinancialsScreen.tsx` (full rewrite)
- Modify: `apps/desktop/src/styles.css` (append)

**Interfaces:**
- Consumes: everything from Tasks 2 through 6.
- Produces: the finished screen.

- [ ] **Step 1: Rewrite the screen**

Replace the entire contents of `apps/desktop/src/screens/FinancialsScreen.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toasts";
import RevenueSection from "../components/finance/RevenueSection";
import ExpenseSection from "../components/finance/ExpenseSection";
import NetCard from "../components/finance/NetCard";
import DonutCard from "../components/finance/DonutCard";
import GlanceCard from "../components/finance/GlanceCard";
import MonthBars from "../components/finance/MonthBars";
import { api, fileUrl } from "../lib/api";
import { openExternal } from "../lib/external";
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

type Phase = "loading" | "ready" | "error";

export default function FinancialsScreen() {
  const toast = useToast();
  const months = monthOptions();
  const [month, setMonth] = useState(months[0]!.value);
  const [data, setData] = useState<FinancialsMonth | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [exportYear, setExportYear] = useState<number | null>(null);
  // Guards the race where a slow response for one month lands after a faster
  // response for another and silently overwrites it.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPhase("loading");
    try {
      const d = await api.get<FinancialsMonth>(`/financials?month=${month}`);
      if (seq.current !== mine) return;
      setData(d);
      setPhase("ready");
    } catch (err) {
      if (seq.current !== mine) return;
      setPhase("error");
      toast.fail("Could not load the month", err);
    }
  }, [month, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh without the skeleton: after an edit the screen already shows
  // real rows, and flashing them out for a beat would make every save feel
  // like a reload. Errors keep the current data and just say so.
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.get<FinancialsMonth>(`/financials?month=${month}`);
      if (seq.current !== mine) return;
      setData(d);
      setPhase("ready");
    } catch (err) {
      if (seq.current !== mine) return;
      toast.fail("Could not refresh the month", err);
    }
  }, [month, toast]);

  const year = exportYear ?? data?.years[0] ?? new Date().getFullYear();

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
        {phase === "loading" && (
          <div className="finskeleton">
            <div className="band">
              <div className="netcard glass skel" />
              <div className="donutcard glass skel" />
              <div className="actcard glass skel" />
            </div>
            <div className="card glass chartcard skel" style={{ height: 260 }} />
            <div className="finload">Loading the month…</div>
          </div>
        )}

        {phase === "error" && (
          <div className="card glass finerror">
            <b>Could not load this month.</b>
            <span>The numbers on this screen are unavailable, not zero.</span>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {phase === "ready" && data && (
          <>
            <div className="band">
              <NetCard series={data.series} />
              <DonutCard rows={data.revenue} totalCents={data.totals.inCents} />
              <GlanceCard totals={data.totals} ytd={data.ytd} />
            </div>

            <MonthBars series={data.series} />

            {data.totals.missingBills > 0 && (
              <div className="warnline" style={{ marginBottom: 10 }}>
                {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not
                entered, so the out and net figures are incomplete.
              </div>
            )}

            <RevenueSection
              rows={data.revenue}
              totalCents={data.totals.inCents}
              month={data.month}
              onChanged={() => void refresh()}
            />

            <div className="cols2">
              <ExpenseSection
                title="Money coming out"
                sub="Recurring only. Rolls forward each month."
                kind="recurring"
                rows={data.recurring}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.recurringOutCents}
                missingCount={data.recurring.filter((r) => r.amountCents === null).length}
                onChanged={() => void refresh()}
              />
              <ExpenseSection
                title="One-off expenses"
                sub="This month only. Does not roll forward, still counts toward taxes."
                kind="one_off"
                rows={data.oneOff}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.oneOffOutCents}
                missingCount={data.oneOff.filter((r) => r.amountCents === null).length}
                onChanged={() => void refresh()}
              />
            </div>

            <div className="card glass" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14.5 }}>Export for taxes</b>
                <div className="sub">
                  Every expense grouped by its Schedule C line, gross receipts by client, meals
                  split at the deductible 50%, and your business details on the cover.
                </div>
              </div>
              <select
                className="field-in repmonth"
                value={year}
                onChange={(e) => setExportYear(Number(e.target.value))}
              >
                {data.years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                onClick={() => {
                  void api
                    .get<{ url: string }>(`/financials/export?year=${year}`)
                    .then((r) => openExternal(fileUrl(r.url)!))
                    .catch((err) => toast.fail("Could not build the tax export", err));
                }}
              >
                Export {year}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
```

Note the old `.fintiles` tiles are gone entirely; the band replaces them. `formatCents` is no longer imported by the screen because every number renders inside a card component.

- [ ] **Step 2: Append the skeleton and error CSS**

In `apps/desktop/src/styles.css`, append to the Financials block:

```css
/* The missing-bills warning also renders standalone above the lists. */
.warnline{font-size:11px;color:var(--amber);line-height:1.4}

/* Loading and error states: the screen never shows a fake $0.00. */
.skel{min-height:150px;animation:skelpulse 1.2s ease-in-out infinite alternate}
@keyframes skelpulse{from{opacity:.55}to{opacity:.9}}
.finload{text-align:center;color:var(--txt-3);font-size:12.5px;padding:18px}
.finerror{display:flex;flex-direction:column;align-items:center;gap:10px;padding:38px;text-align:center}
.finerror b{font-size:15px}
.finerror span{font-size:12.5px;color:var(--txt-3)}
```

- [ ] **Step 3: Typecheck and full check run**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.
Run: `pnpm --filter @toreroflow/desktop test`
Expected: two "all checks passed" lines.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/screens/FinancialsScreen.tsx apps/desktop/src/styles.css
git commit -m "feat: full financials screen with charts, expenses, honest loading, and export year"
```

---

### Task 8: Permanent prices in Settings

**Files:**
- Modify: `apps/api/src/routes/clients.ts` (the `GET /clients` mapper)
- Modify: `apps/desktop/src/lib/api.ts` (`ClientSummary`)
- Modify: `apps/desktop/src/screens/SettingsScreen.tsx`

**Interfaces:**
- Consumes: existing `PATCH /clients/:id/billing` (accepts `monthlyPriceCents`, `billingMode`).
- Produces: `ClientSummary.monthlyPriceCents: number | null` and `ClientSummary.billingMode: "calendar" | "on_fulfilment"`; a `BillingFields` component rendered inside the expanded client card next to `ContactFields`.

- [ ] **Step 1: Return the two fields from GET /clients**

In `apps/api/src/routes/clients.ts`, in the `GET /clients` return mapper (the object starting `id: c.id,`), add after `contactPhone: c.contactPhone,`:

```ts
        monthlyPriceCents: c.monthlyPriceCents,
        billingMode: c.billingMode,
```

- [ ] **Step 2: Extend ClientSummary**

In `apps/desktop/src/lib/api.ts`, inside `interface ClientSummary`, add after `contactPhone`:

```ts
  contactPhone: string | null;
  /** Standing monthly price; the Financials month seeds from this. */
  monthlyPriceCents: number | null;
  billingMode: "calendar" | "on_fulfilment";
```

- [ ] **Step 3: BillingFields in Settings**

In `apps/desktop/src/screens/SettingsScreen.tsx`, add this component directly below the `ContactFields` function:

```tsx
/**
 * The standing price and billing mode, saved on blur like the contact
 * fields. Changing the price never rewrites months that already seeded;
 * only future months pick it up, which is why this lives in Settings and
 * the per-month number lives on the Financials screen.
 */
function BillingFields({ client, onSaved }: { client: ClientSummary; onSaved(): void }) {
  const toast = useToast();
  const [dollars, setDollars] = useState(
    client.monthlyPriceCents === null ? "" : (client.monthlyPriceCents / 100).toFixed(2),
  );
  const [saving, setSaving] = useState(false);

  const savePrice = async () => {
    const stored = client.monthlyPriceCents === null ? "" : (client.monthlyPriceCents / 100).toFixed(2);
    if (dollars.trim() === stored) return;
    const parsed = dollars.trim() === "" ? null : Number.parseFloat(dollars);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.fail(`Could not save ${client.name}'s price`, new Error("enter a valid amount"));
      setDollars(stored);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/clients/${client.id}/billing`, {
        monthlyPriceCents: parsed === null ? null : Math.round(parsed * 100),
      });
      onSaved();
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s price`, err);
      setDollars(stored);
    } finally {
      setSaving(false);
    }
  };

  const saveMode = async (mode: "calendar" | "on_fulfilment") => {
    if (mode === client.billingMode) return;
    try {
      await api.patch(`/clients/${client.id}/billing`, { billingMode: mode });
      onSaved();
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s billing mode`, err);
    }
  };

  return (
    <div className="pcontact">
      <label className="cfield">
        <span className="lab">
          Monthly price
          {saving && <i> saving…</i>}
        </span>
        <div className="pricein">
          <span>$</span>
          <input
            className="field-in"
            type="number"
            min="0"
            step="0.01"
            placeholder="not billed"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            onBlur={() => void savePrice()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
      </label>
      <label className="cfield">
        <span className="lab">Billing</span>
        <div className="modepick">
          <button
            className={client.billingMode === "calendar" ? "on" : ""}
            onClick={() => void saveMode("calendar")}
          >
            Monthly
          </button>
          <button
            className={client.billingMode === "on_fulfilment" ? "on" : ""}
            onClick={() => void saveMode("on_fulfilment")}
          >
            When delivered
          </button>
        </div>
      </label>
    </div>
  );
}
```

Then find where `<ContactFields client={...} onSaved={...} />` is rendered inside the expanded card, and render the billing fields directly beneath it with the same props:

```tsx
              <BillingFields client={client} onSaved={onContactSaved} />
```

(The `onContactSaved` callback already refreshes the clients list, which is exactly what the billing fields need too.)

- [ ] **Step 4: Typecheck both packages**

Run: `pnpm --filter @toreroflow/api typecheck`
Expected: exit 0.
Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clients.ts apps/desktop/src/lib/api.ts apps/desktop/src/screens/SettingsScreen.tsx
git commit -m "feat: standing price and billing mode editable from Settings"
```

---

### Task 9: Live verification walk

**Files:** none modified. The spec's verification section against the running stack. Prereq: Docker, API, worker running; use the Vite dev app or rebuild the installed app.

- [ ] **Step 1:** `pnpm -r typecheck` and `pnpm --filter @toreroflow/core test && pnpm --filter @toreroflow/api test && pnpm --filter @toreroflow/desktop test`. All pass.
- [ ] **Step 2:** Open Financials. Expect the loading skeleton first, then the band (Net card with dash or delta, donut with per-client bars, At a glance), the twelve-month bars, revenue rows, both expense sections, and the export card with a year dropdown. No $0.00 flash.
- [ ] **Step 3:** Click a revenue amount, change it, press Enter. Expect the row, donut, Net card, At a glance, and current-month bar all move. Switch to the prior month and back: the edit stayed on its month only.
- [ ] **Step 4:** Add a recurring cost with a blank amount. Expect a Missing tag, a dash amount, the missing-bills warning line, and the totals unchanged. Fill the amount in by clicking the dash. Expect Money out and Net to move.
- [ ] **Step 5:** Add a one-off meals expense with an amount. Expect the sub line to show the 50% deductible note. Delete it with the two-click SURE? button.
- [ ] **Step 6:** Confirm the Invoice button shows only on delivered on_fulfilment rows (a calendar client like Caleb shows none).
- [ ] **Step 7:** In Settings, expand a client card, change the monthly price. Back on Financials: the current month's amount is unchanged. (Full future-month seeding proof arrives next month by design; the create-only upsert is covered by the Phase 1 checks.)
- [ ] **Step 8:** Stop the API. Switch months. Expect the error card with Try again, no fake zeros. Restart the API, click Try again, expect recovery.
- [ ] **Step 9:** Pick a year in the export dropdown and export. Expect the PDF to open.
- [ ] **Step 10:** Delete every test row created during the walk and re-verify the totals match the pre-walk numbers.
