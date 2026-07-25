import { useEffect, useRef, useState } from "react";
import Pf from "../components/Pf";
import {
  api,
  fileUrl,
  type AccountAnalytics,
  type ClientAnalytics,
  type ClientPost,
} from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
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

const color = (p: string): string => PLATFORM_COLOR[p as Platform] ?? "#8b7bff";

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n * 10) / 10);
}

function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return "-";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** YouTube's default.jpg is tiny; swap for the medium-quality frame. */
function thumb(url: string | null): string | null {
  if (!url) return null;
  return url.includes("ytimg.com") ? url.replace("/default.jpg", "/mqdefault.jpg") : url;
}

/** Follower change across the analytics window (first vs last snapshot). */
function gain(a: AccountAnalytics): number | null {
  const f = a.history.map((h) => h.followers).filter((x): x is number => x != null);
  if (f.length < 2) return null;
  return f[f.length - 1]! - f[0]!;
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

function GainRows({ accounts, label }: { accounts: AccountAnalytics[]; label: string }) {
  if (!accounts.length) {
    return (
      <div className="empty" style={{ padding: "12px 8px" }}>
        <b>Nothing connected</b>
        <p>{label} appear once an account is connected.</p>
      </div>
    );
  }
  return (
    <div className="angain">
      {accounts.map((a) => {
        const d = gain(a);
        return (
          <div className="arow" key={a.id}>
            <Pf p={PF_ID[a.platform]} size="sm" />
            <div className="who">
              <b>{a.displayName ?? `@${a.handle}`}</b>
              <span>@{a.handle}</span>
            </div>
            <span className="cur">{fmt(a.followers)}</span>
            <span className={`delta ${d == null || d === 0 ? "flat" : d > 0 ? "up" : "down"}`}>
              {d == null ? "–" : d > 0 ? `+${fmt(d)}` : fmt(d)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RankCard({ title, range, posts }: { title: string; range: string; posts: ClientPost[] }) {
  return (
    <div className="card glass">
      <h3>{title}</h3>
      <div className="sub">{range}</div>
      {posts.length ? (
        posts.map((p, i) => (
          <div className="rrow" key={p.id} title={p.title}>
            <span className="n">{i + 1}</span>
            <Pf p={PF_ID[p.platforms[0] ?? "instagram"]} size="sm" />
            <span className="t">{p.title}</span>
            <span className="v">{fmt(p.views)}</span>
          </div>
        ))
      ) : (
        <div className="empty" style={{ padding: "12px 8px" }}>
          <b>No videos in this range yet</b>
          <p>Rows appear as videos cross the threshold.</p>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsScreen({ onOpenConnect }: { onOpenConnect?: () => void }) {
  const { clients, selectedClient, selectClient } = useAppState();
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [posts, setPosts] = useState<ClientPost[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  useEffect(() => {
    if (!selectedClient) {
      setData(null);
      setPosts(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<ClientAnalytics>(`/clients/${selectedClient.id}/analytics`),
      api.get<{ posts: ClientPost[] }>(`/clients/${selectedClient.id}/analytics/posts`),
    ])
      .then(([a, p]) => {
        if (cancelled) return;
        setData(a);
        setPosts(p.posts);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setPosts(null);
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

  const all = posts ?? [];
  const accounts = data?.accounts ?? [];
  const ytAccounts = accounts.filter((a) => a.platform === "youtube");
  const otherAccounts = accounts.filter((a) => a.platform !== "youtube");

  const totalViews = all.reduce((s, p) => s + p.views, 0);
  const fallbackWatch = data?.totals.avgWatchSec ?? null;
  const watchSecKnown = all.some((p) => p.avgWatchSec != null) || fallbackWatch != null;
  const watchHours = watchSecKnown
    ? all.reduce((s, p) => s + p.views * (p.avgWatchSec ?? fallbackWatch ?? 0), 0) / 3600
    : null;
  const subscribers = ytAccounts.reduce((s, a) => s + (a.followers ?? 0), 0);
  const followers = otherAccounts.reduce((s, a) => s + (a.followers ?? 0), 0);

  const kpis = [
    { label: "Views", value: fmt(all.length ? totalViews : (data?.totals.views ?? null)) },
    { label: "Watch time · hrs", value: watchHours != null ? fmt(watchHours) : "-" },
    { label: "Subscribers", value: ytAccounts.length ? fmt(subscribers) : "-" },
    { label: "Followers", value: otherAccounts.length ? fmt(followers) : "-" },
  ];

  // Pie: views share per platform across every post.
  const pieMap = new Map<string, number>();
  for (const p of all) {
    for (const b of p.byPlatform) {
      if (b.views > 0) pieMap.set(b.platform, (pieMap.get(b.platform) ?? 0) + b.views);
    }
  }
  const pie = [...pieMap.entries()].map(([platform, views]) => ({ platform, views }));
  const pieTotal = pie.reduce((s, m) => s + m.views, 0);
  const C = 2 * Math.PI * 54;
  let pieOffset = 0;
  const pieSegs = pie.map((m) => {
    const frac = m.views / pieTotal;
    const seg = { ...m, frac, dash: frac * C, offset: -pieOffset };
    pieOffset += frac * C;
    return seg;
  });

  // Per-video bars: the 10 most recent, chronological left to right.
  const barPosts = all.slice(0, 10).reverse();
  const maxBar = Math.max(1, ...barPosts.map((p) => p.views));

  const last10 = all.slice(0, 10);
  const mostViewed = [...all].sort((a, b) => b.views - a.views).slice(0, 8);
  const byViews = [...all].sort((a, b) => b.views - a.views);
  const bucket1m = byViews.filter((p) => p.views >= 1_000_000).slice(0, 10);
  const bucket100k = byViews.filter((p) => p.views >= 100_000 && p.views < 1_000_000).slice(0, 10);
  const bucket10k = byViews.filter((p) => p.views >= 10_000 && p.views < 100_000).slice(0, 10);

  const history = data ? mergedViewHistory(data) : [];
  const maxViews = Math.max(1, ...history.map((h) => h.views));
  const chartPoints = history.map((h, i) => {
    const x = history.length > 1 ? (i / (history.length - 1)) * 720 : 360;
    const y = 220 - (h.views / maxViews) * 185;
    return `${Math.round(x)},${Math.round(y)}`;
  });

  const avatar = selectedClient ? clientAvatarUrl(selectedClient) : null;
  const connectedPlatforms = selectedClient
    ? selectedClient.accounts.filter((a) => a.status === "connected")
    : [];

  return (
    <section className="screen active" data-screen="analytics">
      <div className="topbar">
        <div className="h">
          <h2>Client Analytics</h2>
          <p>
            {selectedClient
              ? `${selectedClient.name}, all connected platforms.`
              : "Pick a brand to see its analytics."}
          </p>
        </div>
        <div className="branddrop" ref={dropRef} style={{ marginLeft: "auto" }}>
          <button className="btn ghost" onClick={() => setMenuOpen((o) => !o)}>
            {selectedClient ? selectedClient.name : "Pick a brand"}
            <svg style={{ width: 14, height: 14 }}>
              <use href="#i-chev" />
            </svg>
          </button>
          {menuOpen && (
            <div className="brandmenu glass">
              {clients.map((client) => (
                <div
                  key={client.id}
                  className={`bm-item${client.id === selectedClient?.id ? " on" : ""}`}
                  onClick={() => {
                    selectClient(client.id);
                    setMenuOpen(false);
                  }}
                >
                  <div
                    className="avatar"
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      fontSize: 10,
                      overflow: "hidden",
                      background: "linear-gradient(135deg,#8b7bff,#4ea8ff)",
                    }}
                  >
                    {clientAvatarUrl(client) ? (
                      <img
                        src={clientAvatarUrl(client)!}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    ) : (
                      (client.avatarSeed ?? client.name.slice(0, 2).toUpperCase())
                    )}
                  </div>
                  {client.name}
                </div>
              ))}
              {clients.length === 0 && (
                <div className="bm-item" style={{ cursor: "default", color: "var(--txt-3)" }}>
                  No brands yet
                </div>
              )}
              {onOpenConnect && (
                <div
                  className="bm-item bm-add"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenConnect();
                  }}
                >
                  + Enroll a client
                </div>
              )}
            </div>
          )}
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
              <p>Pick a brand from the dropdown above, or enroll one to get started.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="anwrap">
              {/* left column */}
              <div className="ancol">
                <div className="card glass">
                  <h3>Views breakdown</h3>
                  <div className="sub" style={{ marginBottom: 14 }}>
                    Share of views per platform
                  </div>
                  {pieSegs.length ? (
                    <div className="donutwrap" style={{ flexDirection: "column" }}>
                      <svg width="150" height="150" viewBox="0 0 130 130">
                        <g transform="rotate(-90 65 65)" fill="none" strokeWidth="17">
                          <circle cx="65" cy="65" r="54" stroke="rgba(255,255,255,.06)" />
                          {pieSegs.map((s) => (
                            <circle
                              key={s.platform}
                              cx="65"
                              cy="65"
                              r="54"
                              stroke={color(s.platform)}
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
                          fontSize="19"
                          fontWeight="700"
                          fontFamily="sans-serif"
                        >
                          {fmt(pieTotal)}
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
                      <div className="dleg" style={{ width: "100%" }}>
                        {pieSegs.map((s) => (
                          <div className="row" key={s.platform}>
                            <span className="d" style={{ background: color(s.platform) }} />{" "}
                            {PLATFORM_LABELS[s.platform as Platform] ?? s.platform}{" "}
                            <b>{Math.round(s.frac * 100)}%</b>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="empty" style={{ padding: "14px 8px" }}>
                      <b>Appears with view data</b>
                      <p>{loading ? "Loading…" : "The breakdown renders once posts report views."}</p>
                    </div>
                  )}
                </div>

                <div className="card glass">
                  <h3>Recent followers</h3>
                  <div className="sub">All platforms except YouTube · 30-day change</div>
                  <GainRows accounts={otherAccounts} label="Follower gains" />
                </div>

                <div className="card glass">
                  <h3>Recent subscribers</h3>
                  <div className="sub">YouTube · 30-day change</div>
                  <GainRows accounts={ytAccounts} label="Subscriber gains" />
                </div>
              </div>

              {/* center column */}
              <div className="ancol mid">
                <div className="ankpis">
                  {kpis.map((k) => (
                    <div className="kpi glass" key={k.label}>
                      <div className="lab">{k.label}</div>
                      <div className="val">{loading ? "…" : k.value}</div>
                    </div>
                  ))}
                </div>

                <div className="card glass">
                  <div className="rowhead">
                    <div>
                      <h3>Views per video</h3>
                      <div className="sub">Last {barPosts.length || "-"} videos, colored by platform</div>
                    </div>
                  </div>
                  {barPosts.length ? (
                    <div className="bars" style={{ height: 190, marginTop: 10 }}>
                      {barPosts.map((p) => (
                        <div className="bar" key={p.id} title={p.title}>
                          <div className="bv">{fmt(p.views)}</div>
                          <div
                            className="fill"
                            style={{
                              height: `${Math.max(3, (p.views / maxBar) * 100)}%`,
                              background: `linear-gradient(180deg,${color(p.platforms[0] ?? "")},#3f6fd0)`,
                            }}
                          />
                          <div className="bl">
                            {new Date(p.publishedAt).toLocaleDateString([], {
                              month: "numeric",
                              day: "numeric",
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty" style={{ padding: "14px 8px" }}>
                      <b>{loading ? "Loading…" : "No videos yet"}</b>
                      <p>Bars render from the provider's post analytics.</p>
                    </div>
                  )}
                </div>

                <div className="card glass">
                  <div className="rowhead">
                    <div>
                      <h3>Last 10 uploads</h3>
                      <div className="sub">Most recent videos across every platform</div>
                    </div>
                  </div>
                  {last10.length ? (
                    <div className="antable">
                      <div className="hd">
                        <span />
                        <span>Video</span>
                        <span style={{ textAlign: "right" }}>Views</span>
                        <span style={{ textAlign: "right" }}>Avg view</span>
                        <span style={{ textAlign: "right" }}>Length</span>
                      </div>
                      {last10.map((p) => (
                        <div className="arow" key={p.id}>
                          <div className="anthumb">
                            {thumb(p.thumbnailUrl) && <img src={thumb(p.thumbnailUrl)!} alt="" />}
                          </div>
                          <div className="t">
                            <b title={p.title}>{p.title}</b>
                            <span>
                              {fmtDate(p.publishedAt)}
                              {" · "}
                              {p.platforms.map((pl) => PLATFORM_LABELS[pl] ?? pl).join(", ")}
                            </span>
                          </div>
                          <div className="m">{fmt(p.views)}</div>
                          <div className="m">{p.avgWatchSec != null ? fmtDur(p.avgWatchSec) : "-"}</div>
                          <div className="m">{fmtDur(p.durationSec)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty" style={{ padding: "14px 8px" }}>
                      <b>{loading ? "Loading…" : "No uploads found"}</b>
                      <p>Connected accounts' videos appear here automatically.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* right column */}
              <div className="ancol">
                <div className="card glass anprofile">
                  <div className="pic">
                    {avatar ? (
                      <img src={avatar} alt={selectedClient.name} />
                    ) : (
                      <div className="pinitials" style={{ height: "100%" }}>
                        {selectedClient.avatarSeed ?? selectedClient.name.slice(0, 2)}
                      </div>
                    )}
                  </div>
                  <b>{selectedClient.name}</b>
                  <div className="sub">
                    {connectedPlatforms.length
                      ? `${connectedPlatforms.length} connected ${connectedPlatforms.length === 1 ? "platform" : "platforms"}`
                      : "No platforms connected"}
                  </div>
                  <div className="icons">
                    {connectedPlatforms.map((a) => (
                      <Pf key={a.id} p={PF_ID[a.platform]} size="sm" />
                    ))}
                  </div>
                </div>

                <div className="card glass">
                  <h3>Most viewed</h3>
                  <div className="sub">Top videos across all platforms</div>
                  {mostViewed.length ? (
                    <div className="anmost">
                      {mostViewed.map((p) => (
                        <div className="arow" key={p.id}>
                          <div className="anthumb" style={{ width: 38, height: 48 }}>
                            {thumb(p.thumbnailUrl) && <img src={thumb(p.thumbnailUrl)!} alt="" />}
                          </div>
                          <div className="t">
                            <b title={p.title}>{p.title}</b>
                            <span>{PLATFORM_LABELS[p.platforms[0] ?? "instagram"] ?? ""}</span>
                          </div>
                          <span className="v">{fmt(p.views)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty" style={{ padding: "14px 8px" }}>
                      <b>{loading ? "Loading…" : "Appears with view data"}</b>
                      <p>Ranks build from every connected platform.</p>
                    </div>
                  )}
                </div>

                <div className="chartcard glass" style={{ marginTop: 0, padding: 16 }}>
                  <div className="rowhead">
                    <div>
                      <h3>Views over time</h3>
                      <div className="sub">Daily, all platforms</div>
                    </div>
                  </div>
                  {history.length >= 2 ? (
                    <svg
                      className="chart"
                      viewBox="0 0 720 230"
                      preserveAspectRatio="none"
                      style={{ height: 120 }}
                    >
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
                      <path d={`M${chartPoints.join(" L")} L720,230 L0,230 Z`} fill="url(#area)" />
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
                    <div className="empty" style={{ padding: "12px 8px" }}>
                      <b>Collecting history</b>
                      <p>The trend draws after a couple of daily snapshots.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="anranks">
              <RankCard title="1M+ club" range="Top 10 videos with 1,000,000+ views" posts={bucket1m} />
              <RankCard title="100K to 999K" range="Top 10 videos in the hundred-thousands" posts={bucket100k} />
              <RankCard title="10K to 99K" range="Top 10 videos in the ten-thousands" posts={bucket10k} />
            </div>

            <div className="note">
              Views, rankings, and uploads pull live from every platform connected under{" "}
              {selectedClient.name}; new platforms join automatically once connected. Watch time is
              estimated where a platform doesn't report it. Export builds a branded PDF report.
            </div>
          </>
        )}
      </div>
    </section>
  );
}
