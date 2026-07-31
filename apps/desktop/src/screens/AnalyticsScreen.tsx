import { useEffect, useRef, useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import {
  api,
  fileUrl,
  type AccountAnalytics,
  type ClientAnalytics,
  type ClientPost,
} from "../lib/api";
import ViewsChart from "../components/ViewsChart";
import { clientAvatarUrl } from "../lib/avatar";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORM_LABELS, type Platform } from "../lib/platforms";
import { buildTier, scopeToPlatform, type ViewTier } from "../lib/viewTiers";
import { useAppState } from "../state/AppState";

const PLATFORM_COLOR: Record<Platform, string> = {
  instagram: "#d62976",
  tiktok: "#25f4ee",
  youtube: "#ff4237",
  snapchat: "#ffe600",
  facebook: "#1877f2",
};

const color = (p: string): string => PLATFORM_COLOR[p as Platform] ?? "#FF6F61";

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

/**
 * A lifetime view-tier board.
 *
 * Ranks every video the client has, whatever range is selected, because a
 * 1M+ club is a record rather than a window. `rangeLabel` describes the
 * selection so the momentum line can say what "recently" means.
 */
function RankCard({
  title,
  range,
  tier,
  rangeLabel,
}: {
  title: string;
  range: string;
  tier: ViewTier;
  rangeLabel: string;
}) {
  const { posts, total, addedInRange } = tier;
  return (
    <div className="card glass">
      <h3>{title}</h3>
      <div className="sub">{range}</div>
      {total > 0 && (
        <div className="rankmeta">
          {total} all time
          {addedInRange > 0 && <span className="up"> · {addedInRange} in {rangeLabel}</span>}
        </div>
      )}
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
          <b>Nothing here yet</b>
          <p>Rows appear as videos cross the threshold.</p>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsScreen({ onOpenConnect }: { onOpenConnect?: () => void }) {
  const { clients, selectedClient, selectClient } = useAppState();
  const toast = useToast();
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [posts, setPosts] = useState<ClientPost[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  /** null means every day the provider has, not an arbitrary window. */
  const [rangeDays, setRangeDays] = useState<number | null>(30);
  const [tab, setTab] = useState<string>("all");
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
  }, [selectedClient, reloadKey]);

  /** Drop the server's cached post list, then refetch everything live. */
  const refresh = async () => {
    if (!selectedClient || refreshing) return;
    setRefreshing(true);
    try {
      await api.post(`/clients/${selectedClient.id}/analytics/refresh`, {});
      setReloadKey((k) => k + 1);
    } catch (err) {
      // Silence here would leave stale numbers looking freshly pulled.
      toast.fail("Could not refresh the analytics", err);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Builds the same monthly report the Reports screen produces, for the
   * month that just ended. Deliberately not a second report design: one
   * client-facing document, one look.
   */
  const exportReport = async () => {
    if (!selectedClient) return;
    setExporting(true);
    try {
      const now = new Date();
      const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const month = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      const res = await api.post<{ url: string }>(
        `/clients/${selectedClient.id}/reports?month=${month}`,
        {},
      );
      const url = fileUrl(res.url);
      if (url) await openExternal(url);
    } catch (err) {
      toast.fail("Could not export the report", err);
    } finally {
      setExporting(false);
    }
  };

  const everyPost = posts ?? [];
  const accountsAll = data?.accounts ?? [];
  const connectedPlatformList = [
    ...new Set(accountsAll.map((a) => a.platform as string)),
  ];
  const activePlatforms = tab === "all" ? connectedPlatformList : [tab];

  /** Oldest publish date the provider gave us, for honest "all time" labels. */
  const earliest = everyPost.reduce<string | null>(
    (min, p) => (min === null || p.publishedAt < min ? p.publishedAt : min),
    null,
  );

  // Range and platform tab narrow every figure on the screen together.
  const cutoff = rangeDays == null ? 0 : Date.now() - rangeDays * 86_400_000;
  const all = scopeToPlatform(
    everyPost.filter((p) => new Date(p.publishedAt).getTime() >= cutoff),
    tab,
  );

  // The tier boards below rank the whole catalogue instead, following the
  // platform tab but never the range. They were built from `all`, so on the
  // default thirty day window a client with six million-view videos saw an
  // empty 1M+ club: the newest of those videos is nine months old.
  const lifetime = scopeToPlatform(everyPost, tab);
  const rangeLabel = rangeDays == null ? "all time" : `${rangeDays}d`;
  const accounts = accountsAll.filter((a) => tab === "all" || a.platform === tab);
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

  // Upload counts per trailing window, across every connected platform.
  const uploadsSince = (days: number) => {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return all.filter((p) => new Date(p.publishedAt).getTime() >= cutoff).length;
  };
  const uploadCounts = [30, 60, 90].map((d) => ({ days: d, count: uploadsSince(d) }));

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
  const tier1m = buildTier(lifetime, 1_000_000, null, cutoff);
  const tier100k = buildTier(lifetime, 100_000, 1_000_000, cutoff);
  const tier10k = buildTier(lifetime, 10_000, 100_000, cutoff);

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
              ? `${selectedClient.name} · ${tab === "all" ? "all platforms" : (PLATFORM_LABELS[tab as Platform] ?? tab)} · ${
                  rangeDays == null
                    ? earliest
                      ? `all history since ${fmtDate(earliest)}`
                      : "all history"
                    : `last ${rangeDays} days`
                }`
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
                      background: "linear-gradient(135deg,#FF6F61,#FF9A73)",
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
          className="btn ghost"
          disabled={!selectedClient || refreshing || loading}
          title="Pull the newest uploads and numbers from every platform"
          onClick={() => void refresh()}
        >
          <svg className={refreshing ? "spin" : undefined}>
            <use href="#i-refresh" />
          </svg>{" "}
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
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
            <div className="anbar">
              <div className="antabs">
                <div
                  className={`antab${tab === "all" ? " on" : ""}`}
                  onClick={() => setTab("all")}
                >
                  Overall
                </div>
                {connectedPlatformList.map((p) => (
                  <div
                    key={p}
                    className={`antab${tab === p ? " on" : ""}`}
                    style={tab === p ? { boxShadow: `inset 0 0 0 1px ${color(p)}` } : undefined}
                    onClick={() => setTab(p)}
                  >
                    <Pf p={PF_ID[p as Platform]} size="sm" />
                    {PLATFORM_LABELS[p as Platform] ?? p}
                  </div>
                ))}
              </div>
              <div className="seg anrange">
                {[30, 60, 90].map((d) => (
                  <span
                    key={d}
                    className={rangeDays === d ? "on" : ""}
                    onClick={() => setRangeDays(d)}
                  >
                    {d}d
                  </span>
                ))}
                <span
                  className={rangeDays === null ? "on" : ""}
                  title={
                    earliest
                      ? `Everything the provider holds, back to ${fmtDate(earliest)}`
                      : "Everything the provider holds"
                  }
                  onClick={() => setRangeDays(null)}
                >
                  All
                </span>
              </div>
            </div>

            <div className="anwrap">
              {/* left column */}
              <div className="ancol">
                <div className="card glass">
                  <h3>Views breakdown</h3>
                  <div className="sub" style={{ marginBottom: 14 }}>
                    Share of views per platform
                  </div>
                  {pieSegs.length ? (
                    <div className="donutwrap">
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

                <div className="card glass anuploads">
                  <div className="rowhead">
                    <div>
                      <h3>Videos uploaded</h3>
                      <div className="sub">Across every connected platform</div>
                    </div>
                  </div>
                  <div className="ucounts">
                    {uploadCounts.map((u) => (
                      <div className="ucount" key={u.days}>
                        <div className="n">{loading ? "…" : u.count}</div>
                        <div className="l">last {u.days} days</div>
                      </div>
                    ))}
                  </div>
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
                      <h3>Views over time</h3>
                      <div className="sub">
                        By publish date{tab === "all" ? ", per platform and combined" : ""}
                      </div>
                    </div>
                  </div>
                  <ViewsChart posts={all} platforms={activePlatforms} />
                </div>

                <div className="card glass">
                  <div className="rowhead">
                    <div>
                      <h3>Last 10 uploads</h3>
                      <div className="sub">
                        {tab === "all"
                          ? "Most recent videos across every platform"
                          : `Most recent ${PLATFORM_LABELS[tab as Platform] ?? tab} videos`}
                      </div>
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

                <div className="card glass">
                  <h3>Followers over time</h3>
                  <div className="sub">Latest snapshot per account</div>
                  <GainRows accounts={accounts} label="Follower counts" />
                </div>
              </div>
            </div>

            <div className="anranks">
              <RankCard
                title="1M+ club"
                range="Top 10 videos with 1,000,000+ views"
                tier={tier1m}
                rangeLabel={rangeLabel}
              />
              <RankCard
                title="100K to 999K"
                range="Top 10 videos with 100,000 to 999,999 views"
                tier={tier100k}
                rangeLabel={rangeLabel}
              />
              <RankCard
                title="10K to 99K"
                range="Top 10 videos with 10,000 to 99,999 views"
                tier={tier10k}
                rangeLabel={rangeLabel}
              />
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
