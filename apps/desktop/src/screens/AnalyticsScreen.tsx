import { useEffect, useState } from "react";
import Pf from "../components/Pf";
import { api, type ClientAnalytics } from "../lib/api";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";
import { useAppState } from "../state/AppState";

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function AnalyticsScreen() {
  const { selectedClient } = useAppState();
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

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

  const kpis = [
    { label: "Total views", value: fmt(data?.totals.views ?? null) },
    { label: "Reach", value: fmt(data?.totals.reach ?? null) },
    { label: "Followers", value: fmt(data?.totals.followers ?? null) },
    { label: "Engagement rate", value: "-" },
    { label: "Avg watch time", value: "-" },
  ];

  return (
    <section className="screen active" data-screen="analytics">
      <div className="topbar">
        <div className="h">
          <h2>Client Analytics</h2>
          <p>
            {selectedClient
              ? `${selectedClient.name} - data fills in once daily ingestion starts.`
              : "Select a brand in the sidebar to see its analytics."}
          </p>
        </div>
        <button
          className="btn"
          disabled
          style={{ opacity: 0.55, cursor: "not-allowed" }}
          title="Branded PDF & share-link exports arrive with analytics ingestion"
        >
          <svg>
            <use href="#i-dl" />
          </svg>{" "}
          Export report
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
              <div className="empty">
                <div className="eic">
                  <svg>
                    <use href="#i-chart" />
                  </svg>
                </div>
                <b>No analytics history yet</b>
                <p>
                  Connected accounts will start filling this chart automatically once daily
                  ingestion is live.
                </p>
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
                <h3>Platform mix</h3>
                <div className="sub" style={{ marginBottom: 10 }}>
                  Share of total views
                </div>
                <div className="empty" style={{ padding: "14px 8px" }}>
                  <b>Appears with real data</b>
                  <p>The donut and reach bars render once live metrics arrive.</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
