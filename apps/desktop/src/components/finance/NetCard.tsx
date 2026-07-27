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
