import { useEffect, useMemo, useState } from "react";
import Pf from "../components/Pf";
import DataProvenance from "../components/DataProvenance";
import { api, type ClientAnalytics } from "../lib/api";
import { PF_ID } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface DashboardScreenProps {
  onOpenInsights(clientId: string): void;
  onOpenConnect(): void;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#FF6F61,#FF9A73)",
  "linear-gradient(135deg,#a07bff,#6a5bff)",
  "linear-gradient(135deg,#FF9A73,#FF6F61)",
  "linear-gradient(135deg,#E8563F,#FF9A73)",
  "linear-gradient(135deg,#FF6F61,#FFB08A)",
];

/** Quick glance across every brand; the Analytics tab is the deep dive. */
const RANGES = [30, 60, 90] as const;

export default function DashboardScreen({ onOpenInsights, onOpenConnect }: DashboardScreenProps) {
  const { clients } = useAppState();
  const [metrics, setMetrics] = useState<Record<string, ClientAnalytics>>({});
  const [days, setDays] = useState<number>(30);

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
    void (async () => {
      const entries = await Promise.all(
        clients.map(async (c) => {
          try {
            return [
              c.id,
              await api.get<ClientAnalytics>(`/clients/${c.id}/analytics?days=${days}`),
            ] as const;
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setMetrics(
          Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, days]);

  return (
    <section className="screen active" data-screen="dashboard">
      <div className="topbar">
        <div className="h">
          <h2>Dashboard</h2>
          <p>
            {clients.length
              ? `Quick overview across ${clients.length} ${clients.length === 1 ? "brand" : "brands"}. Click a card for the full picture.`
              : "Enroll your first brand and its results will show up here."}
          </p>
        </div>
        <div className="seg">
          {RANGES.map((r) => (
            <span key={r} className={days === r ? "on" : ""} onClick={() => setDays(r)}>
              {r}d
            </span>
          ))}
        </div>
        <button className="btn" onClick={onOpenConnect}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          Add client
        </button>
      </div>
      <div className="stage">
        {clients.length === 0 ? (
          <div className="card glass">
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-globe" />
                </svg>
              </div>
              <b>Nothing to show yet</b>
              <p>Every brand you enroll gets its own results card here.</p>
            </div>
          </div>
        ) : (
          <div className="clients">
            {clients.map((client, i) => {
              const m = metrics[client.id];
              const connected = client.accounts.filter((a) => a.status === "connected");
              const avatar =
                connected.find((a) => a.platform === "instagram" && a.avatarUrl)?.avatarUrl ??
                connected.find((a) => a.avatarUrl)?.avatarUrl ??
                null;
              const stats: Array<[string, string]> = [
                ["Views", fmt(m?.totals.views ?? null)],
                [
                  "Retention",
                  m?.totals.avgWatchSec != null ? `${m.totals.avgWatchSec.toFixed(1)}s` : "-",
                ],
                ["Likes", m?.hasData ? fmt(m.totals.likes) : "-"],
                ["Comments", m?.hasData ? fmt(m.totals.comments) : "-"],
              ];
              return (
                <div
                  className="cc glass"
                  key={client.id}
                  onClick={() => onOpenInsights(client.id)}
                >
                  <div className="top">
                    <div
                      className="avatar lg"
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 13,
                        fontSize: 15,
                        overflow: "hidden",
                        background: AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length],
                      }}
                    >
                      {avatar ? (
                        <img
                          src={avatar}
                          alt=""
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        client.avatarSeed ?? client.name.slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div className="meta">
                      <b>{client.name}</b>
                      <span>
                        {connected.length
                          ? `${connected.length} connected ${connected.length === 1 ? "platform" : "platforms"}`
                          : "no platforms connected"}
                      </span>
                    </div>
                  </div>
                  <div className="plat">
                    {connected.map((a) => (
                      <Pf key={a.id} p={PF_ID[a.platform]} />
                    ))}
                  </div>
                  <div className="dashstats">
                    {stats.map(([label, value]) => (
                      <div className="dashstat" key={label}>
                        <div className="lab">{label}</div>
                        <div className="val">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {clients.length > 0 && (
          <div className="note">
            Metrics populate automatically once analytics ingestion is live.
          </div>
        )}
        {/* Every brand's platforms together: the dashboard is the one screen
            that spans all of them, so its footer names the whole set. */}
        <DataProvenance platforms={allPlatforms} />
      </div>
    </section>
  );
}
