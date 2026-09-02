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
 * The last twelve months, two bars each: green is what came in, red is what
 * went out, standing side by side on the same scale so the eye compares them
 * directly. The old single bar sized itself by income and painted cost inside
 * it, which meant a month that cost more than it earned showed as pure red
 * and manually added income became invisible exactly when it mattered most.
 *
 * Clicking a bar opens that month. The whole screen already reads whichever
 * month it is pointed at, so this needs no history view of its own: the same
 * money in, money out, one-off costs, yearly share, tax and net cards simply
 * fill with that month. Past months come back read-only from the API, which
 * is what stops a look back turning into an edit.
 */
export default function MonthBars({
  series,
  onPick,
}: {
  series: SeriesPoint[];
  onPick(month: string): void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Both directions share the axis: a $1,400 cost month must tower over a
  // $570 income month, not erase it.
  const max = niceCeil(Math.max(...series.map((p) => Math.max(p.inCents, p.outCents))));
  const active = hover ?? series.length - 1;
  const labels = [max, (max * 3) / 4, max / 2, max / 4, 0];

  return (
    <div className="card glass finchart">
      <div className="rowhead">
        <div>
          <h3>Last 12 months</h3>
          <div className="sub">
            Green is what came in, red is what went out, side by side. Click a month to open it.
          </div>
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
            const inPct = (p.inCents / max) * 100;
            const outPct = (p.outCents / max) * 100;
            return (
              <div
                className={`col${i === active ? " on" : ""}`}
                key={p.month}
                role="button"
                tabIndex={0}
                title={`Open ${shortMonth(p.month)} ${p.month.slice(0, 4)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onPick(p.month)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(p.month);
                  }
                }}
              >
                {i === active && (
                  <div className="tip">
                    {formatCents(p.inCents)} in · {formatCents(p.outCents)} out
                  </div>
                )}
                <div className="tk">
                  <div className="fill i" style={{ height: `${inPct.toFixed(1)}%` }} />
                  <div className="fill o" style={{ height: `${outPct.toFixed(1)}%` }} />
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
