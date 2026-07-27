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
  const max = niceCeil(Math.max(...series.map((p) => p.inCents)));
  const active = hover ?? series.length - 1;
  const labels = [max, (max * 3) / 4, max / 2, max / 4, 0];

  return (
    <div className="card glass finchart">
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
