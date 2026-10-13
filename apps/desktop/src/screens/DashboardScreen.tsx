import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import BrandAvatar from "../components/BrandAvatar";
import BrandViewsChart from "../components/BrandViewsChart";
import DataProvenance from "../components/DataProvenance";
import PageHeader from "../components/PageHeader";
import Pf from "../components/Pf";
import { api, type ClientAnalytics } from "../lib/api";
import { brandColor } from "../lib/avatar";
import { dailyViews, pctChange } from "../lib/brandTrend";
import type { ScreenId } from "../lib/nav";
import { PF_ID } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import "./DashboardScreen.css";

interface DashboardScreenProps {
  onOpenInsights(clientId: string): void;
  onOpenConnect(): void;
  onNavigate(screen: ScreenId): void;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

const fmtPct = (p: number) => `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}%`;

/** Quick glance across every brand; the Analytics tab is the deep dive. */
const RANGES = [30, 60, 90] as const;

interface BrandData {
  a: ClientAnalytics;
  /** Views in the window before this one; null when that request failed. */
  prevViews: number | null;
  series: number[];
}

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; data: Record<string, BrandData> };

/** A small trend line for a card, same shape as the mockup's. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  // Min to max, not zero to max: a sparkline is about shape, not size.
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * 120).toFixed(1)},${(33 - ((v - min) / span) * 30).toFixed(1)}`)
    .join(" ");
  return (
    <svg width="120" height="36" viewBox="0 0 120 36" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  );
}

export default function DashboardScreen({ onOpenInsights, onOpenConnect, onNavigate }: DashboardScreenProps) {
  const { clients } = useAppState();
  const [days, setDays] = useState<number>(30);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  /** Every platform connected anywhere, since this screen spans all brands. */
  const allPlatforms = useMemo(
    () =>
      clients.flatMap((c) =>
        c.accounts.filter((a) => a.status === "connected").map((a) => a.platform),
      ),
    [clients],
  );

  useEffect(() => {
    if (!clients.length) return;
    let cancelled = false;
    setLoad({ state: "loading" });
    void (async () => {
      const entries = await Promise.all(
        clients.map(async (c) => {
          // ponytail: the previous period is the doubled window minus this one,
          // so each brand costs two requests. A prevViews field on the
          // analytics route would make it one.
          const [cur, both] = await Promise.allSettled([
            api.get<ClientAnalytics>(`/clients/${c.id}/analytics?days=${days}`),
            api.get<ClientAnalytics>(`/clients/${c.id}/analytics?days=${days * 2}`),
          ]);
          if (cur.status === "rejected") return null;
          const a = cur.value;
          const prevViews = both.status === "fulfilled" ? both.value.totals.views - a.totals.views : null;
          return [c.id, { a, prevViews, series: dailyViews(a, days) }] as const;
        }),
      );
      if (cancelled) return;
      const ok = entries.filter((e): e is NonNullable<typeof e> => e !== null);
      // One brand failing still shows the rest; only nothing at all is an error.
      setLoad(ok.length ? { state: "ready", data: Object.fromEntries(ok) } : { state: "error" });
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, days, nonce]);

  const state = clients.length === 0 ? "empty" : load.state;
  const data = load.state === "ready" ? load.data : {};

  /** CSV of exactly what the cards show, for pasting into a client email. */
  const exportReport = () => {
    const rows = [["Brand", "Views", "Change %", "Retention (s)", "Likes", "Comments"]];
    for (const c of clients) {
      const d = data[c.id];
      if (!d) continue;
      const p = pctChange(d.a.totals.views, d.prevViews);
      rows.push([
        c.name,
        String(d.a.totals.views),
        p == null ? "" : p.toFixed(1),
        d.a.totals.avgWatchSec == null ? "" : d.a.totals.avgWatchSec.toFixed(1),
        String(d.a.totals.likes),
        String(d.a.totals.comments),
      ]);
    }
    const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `toreroflow-dashboard-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const series = clients
    .map((c, i) => ({ id: c.id, name: c.name, color: brandColor(i), values: data[c.id]?.series ?? [] }))
    .filter((s) => s.values.length > 1);
  const totalViews = clients.reduce((s, c) => s + (data[c.id]?.a.totals.views ?? 0), 0);
  const knownPrev = clients.filter((c) => data[c.id]?.prevViews != null);
  const totalChange = knownPrev.length
    ? pctChange(
        knownPrev.reduce((s, c) => s + data[c.id]!.a.totals.views, 0),
        knownPrev.reduce((s, c) => s + data[c.id]!.prevViews!, 0),
      )
    : null;
  const chartLabel =
    `Views per day over the last ${days} days. ` +
    series
      .map((s) => {
        const d = data[s.id]!;
        const p = pctChange(d.a.totals.views, d.prevViews);
        return `${s.name}: ${fmt(d.a.totals.views)}${p == null ? "" : `, ${p >= 0 ? "up" : "down"} ${Math.abs(p).toFixed(1)}%`}.`;
      })
      .join(" ");

  // Day labels under the chart: five, evenly spaced, ending today.
  const ticks = [0, 1, 2, 3, 4].map((k) => {
    const back = Math.round(((4 - k) / 4) * (days - 1));
    return new Date(Date.now() - back * 86_400_000).toLocaleDateString([], { month: "short", day: "numeric" });
  });

  const controls = (
    <>
      <div className="tf-seg glass-z1" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={days === r}
            onClick={() => setDays(r)}
            data-testid={`dashboard.range.${r}`}
          >
            {r}d
          </button>
        ))}
      </div>
      <button type="button" className="tf-btn glass-z1" onClick={refresh} disabled={state === "loading"} data-testid="dashboard.refresh">
        <svg aria-hidden="true">
          <use href="#i-refresh" />
        </svg>
        Refresh
      </button>
      <button type="button" className="tf-btn glass-z1" onClick={exportReport} disabled={state !== "ready"} data-testid="dashboard.export">
        <svg aria-hidden="true">
          <use href="#i-dl" />
        </svg>
        Export report
      </button>
      <button type="button" className="tf-btn pri" onClick={onOpenConnect} data-testid="dashboard.add-client">
        <svg aria-hidden="true">
          <use href="#i-plus" />
        </svg>
        Add client
      </button>
    </>
  );

  return (
    <section className="dash" data-screen="dashboard" data-state={state} aria-busy={state === "loading"}>
      <PageHeader
        screen="dashboard"
        onNavigate={onNavigate}
        subtitle={`Toreroflow by Torerone · ${
          clients.length
            ? `Quick overview across ${clients.length} ${clients.length === 1 ? "brand" : "brands"}`
            : "Add your first brand to get started"
        }`}
        controls={controls}
      />

      {state === "empty" && (
        <div className="dash-msg glass-z1" data-testid="dashboard.empty">
          <b>No brands yet</b>
          <p>Every brand you add gets its own results card here.</p>
          <button type="button" className="tf-btn pri" onClick={onOpenConnect} data-testid="dashboard.empty.add-client">
            Add client
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="dash-msg glass-z1" role="alert" data-testid="dashboard.error">
          <b>Could not load the numbers</b>
          <p>None of the brands' analytics came back. Check that the API is online, then try again.</p>
          <button type="button" className="tf-btn glass-z1" onClick={refresh} data-testid="dashboard.retry">
            Retry
          </button>
        </div>
      )}

      {(state === "loading" || state === "ready") && (
        <>
          <div className="dash-cards">
            {clients.map((client, i) => {
              const d = data[client.id];
              const connected = client.accounts.filter((a) => a.status === "connected");
              const change = d ? pctChange(d.a.totals.views, d.prevViews) : null;
              const changeColor = change != null && change < 0 ? "var(--c-bad)" : "var(--c-ok)";
              const nameId = `brand-${client.id}`;
              const tiles: Array<[string, string]> = [
                ["Views", d ? fmt(d.a.totals.views) : "-"],
                ["Retention", d?.a.totals.avgWatchSec != null ? `${d.a.totals.avgWatchSec.toFixed(1)}s` : "-"],
                ["Likes", d?.a.hasData ? fmt(d.a.totals.likes) : "-"],
                ["Comments", d?.a.hasData ? fmt(d.a.totals.comments) : "-"],
              ];
              return (
                <section
                  key={client.id}
                  className="bcard glass-z1"
                  aria-labelledby={nameId}
                  onClick={() => onOpenInsights(client.id)}
                  data-testid={`dashboard.brand-card.${client.id}`}
                >
                  <div className="bcard-h">
                    <BrandAvatar client={client} index={i} />
                    <div className="bcard-name">
                      <h2 id={nameId}>
                        {/* The card is clickable for a mouse; this is the same
                            action for a keyboard or a bot. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenInsights(client.id);
                          }}
                          data-testid={`dashboard.brand-card.${client.id}.open`}
                        >
                          {client.name}
                        </button>
                      </h2>
                      <small>
                        {connected.length
                          ? `${connected.length} connected ${connected.length === 1 ? "platform" : "platforms"}`
                          : "No platforms connected"}
                      </small>
                    </div>
                    {d && d.series.length > 1 && change != null && (
                      <div className="bc-trend">
                        <Sparkline values={d.series} color={changeColor} />
                        <div>
                          <em style={{ color: changeColor }}>{fmtPct(change)}</em> <span>views</span>
                        </div>
                      </div>
                    )}
                  </div>
                  {connected.length > 0 && (
                    <div className="bcard-pf" aria-label="Connected platforms">
                      {connected.map((a) => (
                        <Pf key={a.id} p={PF_ID[a.platform]} size="sm" />
                      ))}
                    </div>
                  )}
                  <dl className="bcard-tiles">
                    {tiles.map(([label, value]) => (
                      <div className="tile glass-z2" key={label}>
                        <dt className="tf-lbl">{label}</dt>
                        <dd>{state === "loading" ? <span className="skel" /> : value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>

          <section className="vot glass-z1" aria-labelledby="vot-title" data-testid="dashboard.views-chart">
            <div className="vot-h">
              <div>
                <h2 id="vot-title" className="tf-lbl">
                  Views over time · all brands
                </h2>
                <div className="vot-total">
                  {state === "loading" ? <span className="skel" /> : fmt(totalViews)}
                  {totalChange != null && (
                    <span style={{ color: totalChange < 0 ? "var(--c-bad)" : "var(--c-ok)" }}>
                      {fmtPct(totalChange)} vs prev {days}d
                    </span>
                  )}
                </div>
              </div>
              <ul className="vot-leg" aria-label="Brands">
                {clients.map((c, i) => (
                  <li key={c.id} style={{ "--c": brandColor(i) } as CSSProperties}>
                    {c.name}
                  </li>
                ))}
              </ul>
            </div>
            <div className="vot-plot">
              {series.length > 0 ? (
                <BrandViewsChart series={series} label={chartLabel} />
              ) : (
                state === "ready" && <p className="vot-none">No daily views recorded in this window yet.</p>
              )}
            </div>
            <div className="vot-x" aria-hidden="true">
              {ticks.map((t, k) => (
                <span key={k}>{t}</span>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Every brand's platforms together: the dashboard is the one screen
          that spans all of them, so its footer names the whole set. */}
      <DataProvenance platforms={allPlatforms} />
    </section>
  );
}
