import { useMemo, useState } from "react";
import Pf from "./Pf";
import type { ClientPost } from "../lib/api";
import { PF_ID, PLATFORM_LABELS, type Platform } from "../lib/platforms";

/** Below this many posts an hour is shown but flagged as a thin sample. */
const CONFIDENT_SAMPLE = 3;

interface HourStat {
  hour: number;
  posts: number;
  avgViews: number;
}

function hourLabel(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Best posting windows derived from the brand's own history: average views
 * per post, bucketed by local hour of day, per platform. Platforms do not
 * expose their native recommendations, so this is measured rather than
 * advised, and each row carries its sample size.
 */
export default function BestTimes({ posts }: { posts: ClientPost[] }) {
  const byPlatform = useMemo(() => {
    const acc = new Map<string, Map<number, { total: number; n: number }>>();
    for (const p of posts) {
      const hour = new Date(p.publishedAt).getHours();
      for (const b of p.byPlatform) {
        if (b.views <= 0) continue;
        let hours = acc.get(b.platform);
        if (!hours) {
          hours = new Map();
          acc.set(b.platform, hours);
        }
        const cell = hours.get(hour) ?? { total: 0, n: 0 };
        cell.total += b.views;
        cell.n += 1;
        hours.set(hour, cell);
      }
    }
    const out = new Map<string, HourStat[]>();
    for (const [platform, hours] of acc) {
      out.set(
        platform,
        [...hours.entries()]
          .map(([hour, c]) => ({ hour, posts: c.n, avgViews: c.total / c.n }))
          .sort((a, b) => b.avgViews - a.avgViews),
      );
    }
    return out;
  }, [posts]);

  const platforms = [...byPlatform.keys()];
  const [active, setActive] = useState<string | null>(null);
  const current = active && byPlatform.has(active) ? active : (platforms[0] ?? null);
  const stats = current ? (byPlatform.get(current) ?? []) : [];
  const top = stats.slice(0, 5);
  const max = Math.max(1, ...top.map((s) => s.avgViews));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!platforms.length) {
    return (
      <div className="sub">
        Best posting windows appear once connected accounts have published
        videos with view data.
      </div>
    );
  }

  return (
    <>
      {platforms.length > 1 && (
        <div className="bttabs">
          {platforms.map((p) => (
            <div
              key={p}
              className={`bttab${p === current ? " on" : ""}`}
              onClick={() => setActive(p)}
            >
              <Pf p={PF_ID[p as Platform]} size="sm" />
              {PLATFORM_LABELS[p as Platform] ?? p}
            </div>
          ))}
        </div>
      )}

      <div className="btrows">
        {top.map((s, i) => (
          <div className="btrow" key={s.hour}>
            <div className="bthour">
              {hourLabel(s.hour)}
              {i === 0 && <span className="btbest">best</span>}
            </div>
            <div className="btbar">
              <div
                className="fill"
                style={{
                  width: `${Math.max(6, (s.avgViews / max) * 100)}%`,
                  opacity: s.posts < CONFIDENT_SAMPLE ? 0.45 : 1,
                }}
              />
            </div>
            <div className="btval">
              {fmt(s.avgViews)}
              <span className={s.posts < CONFIDENT_SAMPLE ? "thin" : undefined}>
                {s.posts} post{s.posts === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="btnote">
        Average views per post by hour, from this brand's own history in{" "}
        {zone.replace(/_/g, " ")}. Faded bars have fewer than {CONFIDENT_SAMPLE} posts
        behind them, so treat them as a hint rather than a pattern.
      </div>
    </>
  );
}
