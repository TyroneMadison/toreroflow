import { useId } from "react";

export interface BrandSeries {
  id: string;
  name: string;
  color: string;
  /** Views per day, oldest first, one entry per day of the window. */
  values: number[];
}

const W = 1000;
const H = 300;

/**
 * A smooth line through the points (Catmull-Rom as cubic Béziers), the curve
 * the mockup draws. Control points are clamped to the plot so a sharp drop
 * cannot swing the line below zero.
 */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  const clamp = (y: number) => Math.min(H, Math.max(0, y));
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Views over time, one area per brand. Stretches to whatever box it is given
 * (preserveAspectRatio none, strokes that do not scale), so the card around it
 * decides the height and there is never an empty band under the plot.
 */
export default function BrandViewsChart({
  series,
  label,
}: {
  series: BrandSeries[];
  /** Spoken summary for screen readers and bots: role="img" hides the paths. */
  label: string;
}) {
  const uid = useId().replace(/:/g, "");
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.12;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * H;
  // Biggest first, so a small brand's area is drawn over a big one, not under it.
  const ordered = [...series].sort(
    (a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0),
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        {ordered.map((s, i) => (
          <linearGradient key={s.id} id={`${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={s.color} stopOpacity=".42" />
            <stop offset="1" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      <g className="vot-grid">
        {[0.15, 0.42, 0.69].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      {ordered.map((s, i) => {
        const line = smoothPath(s.values.map((v, j) => [x(j), y(v)]));
        if (!line) return null;
        return (
          <g key={s.id}>
            <path d={`${line} L${W} ${H} L0 ${H}Z`} fill={`url(#${uid}-${i})`} />
            <path
              d={line}
              fill="none"
              stroke={s.color}
              strokeWidth="3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}
