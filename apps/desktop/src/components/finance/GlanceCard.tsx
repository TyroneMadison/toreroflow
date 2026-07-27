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
