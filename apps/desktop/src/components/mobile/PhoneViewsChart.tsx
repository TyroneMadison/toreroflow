import { useId, useRef, useState, type PointerEvent } from "react";
import type { BrandSeries } from "../BrandViewsChart";

const VW = 326;
const VH = 146;
const X0 = 30;
const X1 = 322;
const Y0 = 8;
const Y1 = 138;

/** 1, 2 or 5 times a power of ten, at or above n. */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Views per day for every brand on one labelled scale (mobile pass). The
 * biggest brand is an area, the rest lines, so a small brand is never hidden
 * under a big one. Tap or drag across the plot to read a day: the bubble
 * lists every brand's views for it.
 */
export default function PhoneViewsChart({ series, days, label }: { series: BrandSeries[]; days: number; label: string }) {
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const top = niceCeil(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i: number) => (n <= 1 ? X0 : X0 + (i / (n - 1)) * (X1 - X0));
  const y = (v: number) => Y1 - (v / top) * (Y1 - Y0);
  const ordered = [...series].sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));
  const big = ordered[0];
  const dayOf = (i: number) => new Date(Date.now() - (n - 1 - i) * 86_400_000);
  const read = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    const vx = ((e.clientX - r.left) / r.width) * VW;
    setPick(Math.max(0, Math.min(n - 1, Math.round(((vx - X0) / (X1 - X0)) * (n - 1)))));
  };
  const ticks = [0, 1, 2, 3, 4].map((k) => {
    const back = Math.round(((4 - k) / 4) * (days - 1));
    return new Date(Date.now() - back * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
  const tipLeft = pick == null ? 0 : Math.min(Math.max((x(pick) / VW) * 100, 22), 78);
  return (
    <div className="mb-vchart">
      <div
        ref={box}
        className="mb-vplot"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          read(e);
        }}
        onPointerMove={(e) => e.buttons && read(e)}
        role="img"
        aria-label={label}
      >
        <svg viewBox={`0 0 ${VW} ${VH}`} aria-hidden="true">
          <defs>
            {big && (
              <linearGradient id={`${uid}-a`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={big.color} stopOpacity=".30" />
                <stop offset="1" stopColor={big.color} stopOpacity="0" />
              </linearGradient>
            )}
          </defs>
          {[1, 2 / 3, 1 / 3].map((f) => (
            <g key={f}>
              <line className="mb-vgrid" x1={X0} x2={X1} y1={y(top * f)} y2={y(top * f)} />
              <text className="mb-vyl" x="0" y={y(top * f) + 3.5}>
                {short(top * f)}
              </text>
            </g>
          ))}
          <line x1={X0} x2={X1} y1={Y1} y2={Y1} className="mb-vbase" />
          <text className="mb-vyl" x="10" y={Y1 + 3.5}>
            0
          </text>
          {big && big.values.length > 1 && (
            <path
              fill={`url(#${uid}-a)`}
              d={`M${big.values.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" L")} L${x(big.values.length - 1)} ${Y1} L${X0} ${Y1} Z`}
            />
          )}
          {[...ordered].reverse().map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke={s.color}
              strokeWidth={s === big ? 2.6 : 2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")}
            />
          ))}
          {pick != null && (
            <>
              <line x1={x(pick)} x2={x(pick)} y1="4" y2={Y1} className="mb-vcursor" />
              {ordered.map((s) => (
                <circle key={s.id} cx={x(pick)} cy={y(s.values[pick] ?? 0)} r="4.5" fill={s.color} className="mb-vdot" />
              ))}
            </>
          )}
        </svg>
        {pick != null && (
          <div className="mb-vtip" style={{ left: `${tipLeft}%` }}>
            <b>{dayOf(pick).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</b>
            {ordered.map((s) => (
              <span key={s.id} style={{ ["--c" as string]: s.color }}>
                <i />
                {s.name}
                <em>{short(s.values[pick] ?? 0)}</em>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="mb-vxl" aria-hidden="true">
        {ticks.map((t, k) => (
          <span key={k} style={{ left: `${((X0 + (k / 4) * (X1 - X0)) / VW) * 100}%` }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
