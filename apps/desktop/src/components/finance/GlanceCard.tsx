import { formatCents } from "@toreroflow/core";
import type { FinancialsMonth } from "../../lib/financials";

/** The month and the year, five numbers, no chart. */
export default function GlanceCard({
  totals,
  ytd,
  bank,
}: {
  totals: FinancialsMonth["totals"];
  ytd: FinancialsMonth["ytd"];
  bank: FinancialsMonth["bank"];
}) {
  return (
    <div className="actcard glass">
      {/* The balance as of the last pull, not a live feed: honesty over
          theatre. Absent entirely when no bank is connected. */}
      {bank && (
        <div
          className="act"
          title={
            bank.asOf
              ? `As of the last pull, ${new Date(bank.asOf).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Press Pull transactions on the bank card to refresh.`
              : "Press Pull transactions on the bank card to refresh."
          }
        >
          <span>In the bank</span>
          <b className="b">{formatCents(bank.totalCents)}</b>
        </div>
      )}
      <div className="act"><span>Money in</span><b className="g">{formatCents(totals.inCents)}</b></div>
      <div className="act"><span>Recurring out</span><b className="r">{formatCents(totals.recurringOutCents)}</b></div>
      <div className="act"><span>One-off out</span><b className="r">{formatCents(totals.oneOffOutCents)}</b></div>
      <div className="act"><span>This year in</span><b>{formatCents(ytd.inCents)}</b></div>
      <div className="act"><span>This year net</span><b>{formatCents(ytd.netCents)}</b></div>
    </div>
  );
}
