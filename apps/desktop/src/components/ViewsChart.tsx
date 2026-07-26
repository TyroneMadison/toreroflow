import { useMemo, useRef, useState } from "react";
import type { ClientPost } from "../lib/api";
import { PLATFORM_LABELS, type Platform } from "../lib/platforms";

const PLATFORM_COLOR: Record<string, string> = {
  instagram: "#d62976",
  tiktok: "#25f4ee",
  youtube: "#ff4237",
  snapchat: "#ffe600",
  facebook: "#1877f2",
};
const color = (p: string): string => PLATFORM_COLOR[p] ?? "#8b7bff";

const W = 760;
const H = 260;
const PAD = { top: 14, right: 16, bottom: 26, left: 46 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function fmtAxis(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** Round a max up to a clean gridline value. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

interface Day {
  key: string;
  label: string;
  total: number;
  byPlatform: Record<string, number>;
}

/**
 * Views by publish date, one line per platform plus a combined total.
 *
 * Note this attributes a video's lifetime views to the day it went out,
 * which is how the provider reports them; it is not views accrued on that
 * calendar day.
 */
export default function ViewsChart({
  posts,
  platforms,
}: {
  posts: ClientPost[];
  platforms: string[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const days = useMemo<Day[]>(() => {
    const map = new Map<string, Day>();
    for (const p of posts) {
      const d = new Date(p.publishedAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let day = map.get(key);
      if (!day) {
        day = {
          key,
          label: d.toLocaleDateString([], { month: "short", day: "numeric" }),
          total: 0,
          byPlatform: {},
        };
        map.set(key, day);
      }
      for (const b of p.byPlatform) {
        if (!platforms.includes(b.platform)) continue;
        day.byPlatform[b.platform] = (day.byPlatform[b.platform] ?? 0) + b.views;
        day.total += b.views;
      }
    }
    return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }, [posts, platforms]);

  if (days.length < 2) {
    return (
      <div className="empty" style={{ padding: "18px 8px" }}>
        <b>Not enough history yet</b>
        <p>The trend needs at least two days with published videos.</p>
      </div>
    );
  }

  const single = platforms.length === 1;
  const max = niceMax(
    Math.max(
      1,
      ...days.map((d) => (single ? (d.byPlatform[platforms[0]!] ?? 0) : d.total)),
    ),
  );
  const x = (i: number) => PAD.left + (days.length === 1 ? PLOT_W / 2 : (i / (days.length - 1)) * PLOT_W);
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;

  const series = single
    ? [{ platform: platforms[0]!, values: days.map((d) => d.byPlatform[platforms[0]!] ?? 0) }]
    : [
        { platform: "__total", values: days.map((d) => d.total) },
        ...platforms.map((p) => ({
          platform: p,
          values: days.map((d) => d.byPlatform[p] ?? 0),
        })),
      ];

  const linePath = (values: number[]) =>
    values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  // Keep x labels readable regardless of how many days are in range.
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (px - PAD.left) / PLOT_W;
    const idx = Math.round(ratio * (days.length - 1));
    setHover(idx >= 0 && idx < days.length ? idx : null);
  };

  const hovered = hover != null ? days[hover] : null;

  return (
    <div className="vchart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="vchart-svg"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="vc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8b7bff" stopOpacity="0.28" />
            <stop offset="1" stopColor="#8b7bff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((v) => (
          <g key={v}>
            <line className="vc-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="vc-ylab" x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end">
              {fmtAxis(v)}
            </text>
          </g>
        ))}

        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d.key} className="vc-xlab" x={x(i)} y={H - 8} textAnchor="middle">
              {d.label}
            </text>
          ) : null,
        )}

        {/* area under the headline series only, so the chart stays readable */}
        <path
          d={`${linePath(series[0]!.values)} L${x(days.length - 1).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)} Z`}
          fill="url(#vc-area)"
        />

        {series.map((s) => (
          <path
            key={s.platform}
            d={linePath(s.values)}
            fill="none"
            stroke={s.platform === "__total" ? "#8b7bff" : color(s.platform)}
            strokeWidth={s.platform === "__total" ? 2.6 : 1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={s.platform === "__total" ? 1 : 0.85}
          />
        ))}

        {hovered && (
          <g>
            <line
              className="vc-cursor"
              x1={x(hover!)}
              x2={x(hover!)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
            />
            {series.map((s) => (
              <circle
                key={s.platform}
                cx={x(hover!)}
                cy={y(s.values[hover!]!)}
                r={s.platform === "__total" ? 4 : 3}
                fill={s.platform === "__total" ? "#8b7bff" : color(s.platform)}
              />
            ))}
          </g>
        )}
      </svg>

      <div className="vc-foot">
        {hovered ? (
          <>
            <b>{hovered.label}</b>
            {!single && <span className="vc-tot">{fmtAxis(hovered.total)} total</span>}
            {platforms.map((p) => (
              <span key={p} className="vc-key">
                <i style={{ background: color(p) }} />
                {PLATFORM_LABELS[p as Platform] ?? p} {fmtAxis(hovered.byPlatform[p] ?? 0)}
              </span>
            ))}
          </>
        ) : (
          <>
            {!single && (
              <span className="vc-key">
                <i style={{ background: "#8b7bff" }} />
                All platforms
              </span>
            )}
            {platforms.map((p) => (
              <span key={p} className="vc-key">
                <i style={{ background: color(p) }} />
                {PLATFORM_LABELS[p as Platform] ?? p}
              </span>
            ))}
            <span className="vc-hint">hover for a day</span>
          </>
        )}
      </div>
    </div>
  );
}
