import { formatCents, type ExpenseCategory } from "@toreroflow/core";
import type { ExpenseRow } from "../../lib/financials";

/**
 * Costs billed once a year, and what they really cost per month.
 *
 * A domain renewal charged every March is money the business spends all year.
 * Seeing it only in March makes eleven months look cheaper than they are and
 * March look like a disaster, so a twelfth of the yearly total is counted in
 * every month's money out. The full figure stays on the row it was charged on,
 * which is what the tax export reads, so nothing is deducted twelve times.
 *
 * Read-only on purpose. A yearly cost is added and edited in Money coming out
 * with the "billed yearly" tick; a second place to create one would be a
 * second place for the same cost to exist twice.
 */
export default function AnnualSection({
  rows,
  categories,
  year,
  shareCents,
  yearCents,
}: {
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  year: string;
  /** A twelfth of the year, already counted in this month's money out. */
  shareCents: number;
  yearCents: number;
}) {
  if (rows.length === 0) return null;
  const byKey = new Map(categories.map((c) => [c.key, c]));
  const missing = rows.filter((r) => r.amountCents === null).length;

  const chargedIn = (row: ExpenseRow): string =>
    new Date(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)) - 1, 1).toLocaleDateString(
      "en-US",
      { month: "long" },
    );

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Billed yearly</h3>
          <div className="sub">
            Charged once, spread across twelve months so every month shows what you are really
            paying.
          </div>
        </div>
        <div className="amt o">
          {formatCents(yearCents)}
          {missing > 0 ? " +" : ""}
        </div>
      </div>

      <div className="kpis" style={{ gridTemplateColumns: "repeat(2,1fr)", marginTop: 14 }}>
        <div className="kpi glass-sm">
          <div className="lab">Per year</div>
          <div className="val">{formatCents(yearCents)}</div>
        </div>
        <div className="kpi glass-sm">
          <div className="lab">Counted every month</div>
          <div className="val">{formatCents(shareCents)}</div>
        </div>
      </div>

      {rows.map((row) => (
        <div className={`lrow${row.amountCents === null ? " miss" : ""}`} key={row.id}>
          <div className="cat">{byKey.get(row.categoryLine)?.emoji ?? "📌"}</div>
          <div className="lmeta">
            <b>{row.name}</b>
            <span>
              {byKey.get(row.categoryLine)?.label ?? row.categoryLine} · charged in{" "}
              {chargedIn(row)}
              {row.amountCents === null
                ? " · bill not entered"
                : ` · ${formatCents(Math.floor(row.amountCents / 12))} a month`}
            </span>
          </div>
          <div className={`amt o${row.amountCents === null ? " unknown" : ""}`}>
            {row.amountCents === null ? "-" : formatCents(row.amountCents)}
          </div>
        </div>
      ))}

      {missing > 0 && (
        <div className="warnline" style={{ marginTop: 10 }}>
          {missing} yearly bill{missing === 1 ? "" : "s"} with no amount entered, so the monthly
          share is lower than the real one.
        </div>
      )}

      <p className="lnote" style={{ marginLeft: 0, marginTop: 8 }}>
        Edit a yearly cost in Money coming out for {year}. It lives there with "billed yearly"
        ticked, which is what puts it on this card.
      </p>
    </div>
  );
}
