import {
  categoryByKey,
  deductibleCents,
  EXPENSE_CATEGORIES,
  formatCents,
  sumCents,
} from "@toreroflow/core";

export interface ExportableExpense {
  name: string;
  categoryLine: string;
  amountCents: number | null;
}

export interface ScheduleCGroup {
  key: string;
  /** Empty when the category is not a deduction and belongs on no line. */
  scheduleCLine: string;
  label: string;
  totalCents: number;
  /**
   * What may actually be claimed. Below the total for meals, which are halved,
   * and zero for categories that are not deductions at all.
   */
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

export interface UncategorisedExpense {
  name: string;
  categoryLine: string;
  amountCents: number;
}

/**
 * Expenses whose categoryLine matches no Schedule C line.
 *
 * groupForScheduleC only ever collects rows that match a known category, so
 * anything left over here is invisible to it, not a duplicate of it. The
 * validation in financeSchemas.ts (z.enum against EXPENSE_CATEGORIES) means
 * no new row can carry a bad key, but rows written before that validation
 * existed still can, and a tax document must account for every dollar
 * rather than let an old typo vanish with no trace.
 */
export function uncategorisedExpenses(expenses: ExportableExpense[]): UncategorisedExpense[] {
  const known = new Set(EXPENSE_CATEGORIES.map((c) => c.key));
  return expenses
    .filter((e) => !known.has(e.categoryLine) && e.amountCents !== null)
    .map((e) => ({ name: e.name, categoryLine: e.categoryLine, amountCents: e.amountCents! }));
}

export interface TaxExportData {
  year: number;
  business: {
    legalName: string;
    ein: string | null;
    address: string | null;
    businessCode: string | null;
    accountingMethod: string;
  };
  grossReceiptsCents: number;
  receiptsByClient: Array<{ name: string; cents: number }>;
  groups: ScheduleCGroup[];
  /** Rendered under their own section and explicitly excluded from the total. */
  uncategorised: UncategorisedExpense[];
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    .map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${formatCents(r.cents)}</td></tr>`)
    .join("");

  const groups = data.groups
    .map((g) => {
      const items = g.items
        .map(
          (i) => `<tr><td>${esc(i.name)}</td><td class="r">${formatCents(i.amountCents)}</td></tr>`,
        )
        .join("");
      // Three cases, and each needs saying out loud on a tax document: a line
      // that is fully deductible, meals which are halved, and a category that
      // is not a deduction at all and would be a wrong return if claimed.
      const split =
        g.deductibleCents === g.totalCents
          ? ""
          : g.deductibleCents === 0
            ? `<tr class="tot"><td>Not deductible, excluded from the total below</td><td class="r">${formatCents(0)}</td></tr>`
            : `<tr class="tot"><td>Deductible at 50%</td><td class="r">${formatCents(g.deductibleCents)}</td></tr>`;
      const heading = g.scheduleCLine
        ? `Line ${esc(g.scheduleCLine)} &middot; ${esc(g.label)}`
        : `${esc(g.label)} &middot; not a Schedule C deduction`;
      return `<h3>${heading}</h3>
        <table>${items}
          <tr class="tot"><td>Spent</td><td class="r">${formatCents(g.totalCents)}</td></tr>
          ${split}
        </table>`;
    })
    .join("");

  const totalDeductible = data.groups.reduce((n, g) => n + g.deductibleCents, 0);

  // Shown under its own heading rather than folded into a group above: these
  // rows carry a categoryLine the app no longer recognises, so the honest
  // thing to put on a tax document is "here they are, and they are NOT
  // counted", not a silent omission or a guess at where they belong.
  const uncategorisedSection = data.uncategorised.length
    ? `<h3>Uncategorised, needs a category before filing</h3>
      <table>
        ${data.uncategorised
          .map(
            (i) =>
              `<tr><td>${esc(i.name)} <span class="muted">(${esc(labelFor(i.categoryLine))})</span></td><td class="r">${formatCents(i.amountCents)}</td></tr>`,
          )
          .join("")}
        <tr class="tot"><td>Not included in the deductible total</td><td class="r">${formatCents(
          sumCents(data.uncategorised.map((i) => i.amountCents)),
        )}</td></tr>
      </table>
      <div class="muted">
        Toreroflow does not recognise the category on these bills, probably a typo or a
        category renamed since they were entered. They are shown here so nothing goes
        missing silently, but they are <b>NOT</b> included in "Total deductible expenses"
        below. Fix the category on each and re-export before filing.
      </div>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Schedule C ${data.year}</title>
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
</head>
<body>
<h1>Schedule C summary, ${data.year}</h1>
<div class="muted">
  ${esc(data.business.legalName)}<br>
  ${data.business.address ? `${esc(data.business.address).replace(/\n/g, "<br>")}<br>` : ""}
  ${data.business.ein ? `EIN ${esc(data.business.ein)}<br>` : "EIN not recorded<br>"}
  ${data.business.businessCode ? `Business code ${esc(data.business.businessCode)}<br>` : "Business code not recorded<br>"}
  Accounting method: ${esc(data.business.accountingMethod)}
</div>

<h3>Gross receipts</h3>
<table>${receipts}
  <tr class="tot"><td>Total</td><td class="r">${formatCents(data.grossReceiptsCents)}</td></tr>
</table>

${groups}

${uncategorisedSection}

<div class="grand"><span>Total deductible expenses</span><span>${formatCents(totalDeductible)}</span></div>

<div class="foot">
  Generated by Toreroflow on ${new Date().toLocaleDateString("en-US")}. These figures are records
  kept in Toreroflow and are not tax advice. Business meals are reported at the 50% deductible
  rate for 2026. Money recorded as Investments is listed for your records and is deliberately not
  deducted: it buys an asset rather than paying for something, and Schedule C has no line for it.
  Expenses with no amount recorded are excluded entirely rather than counted as zero, so confirm
  every bill has been entered before filing.
</div>
</body>
</html>`;
}
