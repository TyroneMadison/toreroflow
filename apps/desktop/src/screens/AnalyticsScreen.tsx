import { useEffect, useState } from "react";
import Pf from "../components/Pf";
import { api, fileUrl, type ClientAnalytics } from "../lib/api";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORM_LABELS, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

const PLATFORM_COLOR: Record<Platform, string> = {
  instagram: "#d62976",
  tiktok: "#25f4ee",
  youtube: "#ff4237",
  snapchat: "#ffe600",
  facebook: "#1877f2",
};

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n * 10) / 10);
}

/** Views summed across accounts per calendar day, oldest first. */
function mergedViewHistory(data: ClientAnalytics): Array<{ day: string; views: number }> {
  const byDay = new Map<string, number>();
  for (const account of data.accounts) {
    for (const point of account.history) {
      const day = new Date(point.capturedAt).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (point.views ?? 0));
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, views]) => ({ day, views }));
}

export default function AnalyticsScreen() {
  const { selectedClient } = useAppState();
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!selectedClient) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<ClientAnalytics>(`/clients/${selectedClient.id}/analytics`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient]);

  const exportReport = async () => {
    if (!selectedClient) return;
    setExporting(true);
    try {
      const res = await api.post<{ url: string }>(`/clients/${selectedClient.id}/report`);
      const url = fileUrl(res.url);
      if (url) await openExternal(url);
    } finally {
      setExporting(false);
    }
  };

  const kpis = [
    { label: "Total views", value: fmt(data?.totals.views ?? null) },
    { label: "Reach", value: fmt(data?.totals.reach ?? null) },
    { label: "Followers", value: fmt(data?.totals.followers ?? null) },
    {
      label: "Engagement rate",
      value:
        data?.totals.engagementRate != null
          ? `${data.totals.engagementRate.toFixed(1)}%`
          : "-",
    },
    {
      label: "Avg watch time",
      value: data?.totals.avgWatchSec != null ? `${data.totals.avgWatchSec.toFixed(1)}s` : "-",
    },
  ];

  const history = data ? mergedViewHistory(data) : [];
  const maxViews = Math.max(1, ...history.map((h) => h.views));
  const chartPoints = history.map((h, i) => {
    const x = history.length > 1 ? (i / (history.length - 1)) * 720 : 360;
    const y = 220 - (h.views / maxViews) * 185;
    return `${Math.round(x)},${Math.round(y)}`;
  });

  const mix = (data?.accounts ?? [])
    .map((a) => ({ platform: a.platform, views: a.latest?.views ?? 0 }))
    .filter((m) => m.views > 0);
  const mixTotal = mix.reduce((s, m) => s + m.views, 0);
  const C = 2 * Math.PI * 54;
  let mixOffset = 0;
  const donutSegs = mix.map((m) => {
    const frac = m.views / mixTotal;
    const seg = { ...m, frac, dash: frac * C, offset: -mixOffset };
    mixOffset += frac * C;
    return seg;
  });

  const reach = (data?.accounts ?? []).map((a) => ({
    platform: a.platform,
    reach: a.latest?.reach ?? 0,
  }));
  const maxReach = Math.max(1, ...reach.map((r) => r.reach));

  return (
    <section className="screen active" data-screen="analytics">
      <div className="topbar">
        <div className="h">
          <h2>Client Analytics</h2>
          <p>
            {selectedClient
              ? `${selectedClient.name}, last 30 days across all platforms.`
              : "Select a brand in the sidebar to see its analytics."}
          </p>
        </div>
        <button
          className="btn"
          disabled={!selectedClient || exporting}
          onClick={() => void exportReport()}
        >
          <svg>
            <use href="#i-dl" />
          </svg>{" "}
          {exporting ? "Building…" : "Export report"}
        </button>
      </div>
      <div className="stage">
        {!selectedClient ? (
          <div className="card glass">
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-chart" />
                </svg>
              </div>
              <b>No brand selected</b>
              <p>Pick a brand from the sidebar dropdown, or add one to get started.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="kpis">
              {kpis.map((k) => (
                <div className="kpi glass" key={k.label}>
                  <div className="lab">{k.label}</div>
                  <div className="val">{loading ? "…" : k.value}</div>
                </div>
              ))}
            </div>

            <div className="chartcard glass">
              <div className="rowhead">
                <div>
                  <h3>Views over time</h3>
                  <div className="sub">Daily views, all platforms combined</div>
                </div>
              </div>
              {history.length >= 2 ? (
                <svg className="chart" viewBox="0 0 720 230" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#4ea8ff" stopOpacity="0.4" />
                      <stop offset="1" stopColor="#4ea8ff" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stopColor="#8b7bff" />
                      <stop offset="1" stopColor="#4ea8ff" />
                    </linearGradient>
                  </defs>
                  <line className="gridline" x1="0" y1="40" x2="720" y2="40" />
                  <line className="gridline" x1="0" y1="100" x2="720" y2="100" />
                  <line className="gridline" x1="0" y1="160" x2="720" y2="160" />
                  <path
                    d={`M${chartPoints.join(" L")} L720,230 L0,230 Z`}
                    fill="url(#area)"
                  />
                  <polyline
                    fill="none"
                    stroke="url(#line)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={chartPoints.join(" ")}
                  />
                </svg>
              ) : (
                <div className="empty">
                  <div className="eic">
                    <svg>
                      <use href="#i-chart" />
                    </svg>
                  </div>
                  <b>{data?.hasData ? "Collecting history" : "No analytics history yet"}</b>
                  <p>
                    The trend line draws after a couple of daily snapshots. Ingestion runs
                    automatically every day.
                  </p>
                </div>
              )}
            </div>

            <div className="two">
              <div className="card glass">
                <h3>Platform mix</h3>
                <div className="sub" style={{ marginBottom: 14 }}>
                  Share of total views
                </div>
                {donutSegs.length ? (
                  <div className="donutwrap">
                    <svg width="130" height="130" viewBox="0 0 130 130">
                      <g transform="rotate(-90 65 65)" fill="none" strokeWidth="16">
                        <circle cx="65" cy="65" r="54" stroke="rgba(255,255,255,.06)" />
                        {donutSegs.map((s) => (
                          <circle
                            key={s.platform}
                            cx="65"
                            cy="65"
                            r="54"
                            stroke={PLATFORM_COLOR[s.platform]}
                            strokeDasharray={`${s.dash} ${C - s.dash}`}
                            strokeDashoffset={s.offset}
                          />
                        ))}
                      </g>
                      <text
                        x="65"
                        y="61"
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize="20"
                        fontWeight="700"
                        fontFamily="sans-serif"
                      >
                        {fmt(mixTotal)}
                      </text>
                      <text
                        x="65"
                        y="78"
                        textAnchor="middle"
                        fill="rgba(128,128,160,.8)"
                        fontSize="10"
                        fontFamily="sans-serif"
                      >
                        views
                      </text>
                    </svg>
                    <div className="dleg">
                      {donutSegs.map((s) => (
                        <div className="row" key={s.platform}>
                          <span className="d" style={{ background: PLATFORM_COLOR[s.platform] }} />{" "}
                          {PLATFORM_LABELS[s.platform]} <b>{Math.round(s.frac * 100)}%</b>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="empty" style={{ padding: "14px 8px" }}>
                    <b>Appears with view data</b>
                    <p>The mix renders once accounts report views.</p>
                  </div>
                )}
              </div>
              <div className="card glass">
                <h3>Reach by platform</h3>
                <div className="sub" style={{ marginBottom: 6 }}>
                  Accounts reached, latest snapshot
                </div>
                {reach.some((r) => r.reach > 0) ? (
                  <div className="bars">
                    {reach.map((r) => (
                      <div className="bar" key={r.platform}>
                        <div className="bv">{fmt(r.reach)}</div>
                        <div
                          className="fill"
                          style={{
                            height: `${Math.max(4, (r.reach / maxReach) * 100)}%`,
                            background: `linear-gradient(180deg,${PLATFORM_COLOR[r.platform]},#3f6fd0)`,
                          }}
                        />
                        <div className="bl">{PLATFORM_LABELS[r.platform]}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty" style={{ padding: "14px 8px" }}>
                    <b>Appears with reach data</b>
                    <p>Bars render from the daily snapshots.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="two">
              <div className="card glass">
                <h3>Connected platforms</h3>
                <div className="sub" style={{ marginBottom: 10 }}>
                  {data?.accounts.length
                    ? "Latest snapshot per account"
                    : "No platforms connected yet - connect them in Settings"}
                </div>
                {data?.accounts.map((a) => (
                  <div className="best" key={a.id}>
                    <div className="l">
                      <Pf p={PF_ID[a.platform]} size="sm" /> {PLATFORM_LABELS[a.platform]}{" "}
                      <span style={{ color: "var(--txt-3)" }}>@{a.handle}</span>
                    </div>
                    <b>{a.latest ? `${fmt(a.latest.views)} views` : "no data yet"}</b>
                  </div>
                ))}
              </div>
              <div className="card glass">
                <h3>Engagement</h3>
                <div className="sub" style={{ marginBottom: 10 }}>
                  Summed across published posts
                </div>
                <div className="best">
                  <div className="l">Likes</div>
                  <b>{fmt(data?.totals.likes ?? null)}</b>
                </div>
                <div className="best">
                  <div className="l">Comments</div>
                  <b>{fmt(data?.totals.comments ?? null)}</b>
                </div>
                <div className="best">
                  <div className="l">Shares</div>
                  <b>{fmt(data?.totals.shares ?? null)}</b>
                </div>
              </div>
            </div>
            <div className="note">
              Snapshots land daily per connected account. Export builds a branded PDF report.
            </div>
          </>
        )}
      </div>
    </section>
  );
}
