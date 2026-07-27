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
