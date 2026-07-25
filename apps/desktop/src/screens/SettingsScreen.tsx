import { useEffect, useRef, useState } from "react";
import Pf from "../components/Pf";
import { api, type ClientAnalytics, type ClientSummary } from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
import { getAutostart, isTauri, setAutostart } from "../lib/autostart";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface SettingsScreenProps {
  onOpenConnect(): void;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function ProfileCard({
  client,
  onConnect,
  onDisconnect,
  onSync,
  busyKey,
  pending,
}: {
  client: ClientSummary;
  onConnect(platform: Platform): void;
  onDisconnect(accountId: string): void;
  onSync(): void;
  busyKey: string | null;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cover, setCover] = useState(false);
  const [analytics, setAnalytics] = useState<ClientAnalytics | null>(null);

  const connected = client.accounts.filter((a) => a.status === "connected");
  const avatar = clientAvatarUrl(client);
  const displayName = connected.find((a) => a.displayName)?.displayName ?? client.name;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get<ClientAnalytics>(`/clients/${client.id}/analytics?days=30`)
      .then((d) => {
        if (!cancelled) setAnalytics(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client.accounts.length]);

  const t = analytics?.totals;
  const cells: Array<[string, string]> = [
    ["Followers", fmt(t?.followers ?? null)],
    ["Views · 30d", fmt(t?.views ?? null)],
    ["Likes · 30d", fmt(t?.likes ?? null)],
    ["Comments · 30d", fmt(t?.comments ?? null)],
    ["Engagement", t?.engagementRate != null ? `${t.engagementRate.toFixed(1)}%` : "-"],
    ["Retention", t?.avgWatchSec != null ? `${t.avgWatchSec.toFixed(1)}s` : "-"],
  ];

  return (
    <div className={`pcard glass${cover ? " cover" : ""}${open ? " open" : ""}`}>
      {cover && avatar && (
        <div className="pcover-bg" style={{ backgroundImage: `url(${avatar})` }} />
      )}
      <div className="pcover-shade" />

      <div className="pmedia">
        {avatar ? (
          <img src={avatar} alt={displayName} />
        ) : (
          <div className="pinitials">{client.avatarSeed ?? client.name.slice(0, 2)}</div>
        )}
      </div>

      <div className="pbody">
        <div className="pname">
          {displayName}
          {connected.length > 0 && (
            <svg className="pverified" viewBox="0 0 24 24">
              <use href="#i-check" />
            </svg>
          )}
        </div>
        <div className="psub">
          {client.name}
          {connected.length
            ? ` · ${connected.length} connected ${connected.length === 1 ? "platform" : "platforms"}`
            : " · no platforms yet"}
        </div>
        <div className="pplat">
          {connected.map((a) => (
            <Pf key={a.id} p={PF_ID[a.platform]} size="sm" />
          ))}
        </div>
        <div className="pactions">
          <button className="btn pexp" onClick={() => setOpen((o) => !o)}>
            {open ? "Collapse" : "Expand"}
          </button>
          <div
            className="iconbtn pstyle"
            title="Switch card style"
            onClick={() => setCover((c) => !c)}
          >
            <svg>
              <use href="#i-image" />
            </svg>
          </div>
        </div>
      </div>

      <div className="pexpand">
        <div className="pexpand-inner">
          <div className="pgridstats">
            {cells.map(([label, value]) => (
              <div className="dashstat" key={label}>
                <div className="lab">{label}</div>
                <div className="val">{analytics ? value : "…"}</div>
              </div>
            ))}
          </div>

          <div className="flabel" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14 }}>
            Platforms
            <span className="link" style={{ textTransform: "none", letterSpacing: 0 }} onClick={onSync}>
              {busyKey === `sync:${client.id}` ? "Syncing…" : "Sync accounts"}
            </span>
          </div>
          {pending && (
            <p style={{ fontSize: 12, color: "var(--amber)", margin: "2px 0 6px" }}>
              Finish authorizing in your browser, then click Sync accounts.
            </p>
          )}
          {PLATFORMS.map((platform) => {
            const account = client.accounts.find(
              (a) => a.platform === platform && a.status === "connected",
            );
            const key = account ? account.id : `${client.id}:${platform}`;
            const busy = busyKey === key;
            return (
              <div className="connect-row" key={platform}>
                <Pf p={PF_ID[platform]} />
                <div className="cinfo">
                  <b>{PLATFORM_LABELS[platform]}</b>
                  <span>{account ? `@${account.handle} · connected` : "not connected"}</span>
                </div>
                {account ? (
                  <button className="dangerbtn" disabled={busy} onClick={() => onDisconnect(account.id)}>
                    {busy ? "…" : "Disconnect"}
                  </button>
                ) : (
                  <button className="cbtn" disabled={busy} onClick={() => onConnect(platform)}>
                    {busy ? "…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function SettingsScreen({ onOpenConnect }: SettingsScreenProps) {
  const { clients, refreshClients, user, logout } = useAppState();
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState<string | null>(null);
  const autoSynced = useRef(false);

  useEffect(() => {
    void getAutostart().then(setAutostartState);
  }, []);

  // Pull provider-side connections in automatically when Settings opens.
  useEffect(() => {
    if (autoSynced.current || !clients.length) return;
    autoSynced.current = true;
    void (async () => {
      for (const client of clients) {
        try {
          await api.post(`/clients/${client.id}/accounts/sync`, {});
        } catch {
          // provider may be unset; manual sync still available
        }
      }
      await refreshClients();
    })();
  }, [clients, refreshClients]);

  const toggleAutostart = async () => {
    if (autostart === null || autostartBusy) return;
    setAutostartBusy(true);
    try {
      await setAutostart(!autostart);
      setAutostartState(await getAutostart());
    } finally {
      setAutostartBusy(false);
    }
  };

  const connect = async (clientId: string, platform: Platform) => {
    setBusyKey(`${clientId}:${platform}`);
    try {
      const res = await api.post<{ authUrl?: string }>(
        `/clients/${clientId}/accounts/${platform}`,
        {},
      );
      if (res.authUrl) {
        await openExternal(res.authUrl);
        setPendingSync(clientId);
      } else {
        await refreshClients();
      }
    } finally {
      setBusyKey(null);
    }
  };

  const disconnect = async (accountId: string) => {
    setBusyKey(accountId);
    try {
      await api.del(`/accounts/${accountId}`);
      await refreshClients();
    } finally {
      setBusyKey(null);
    }
  };

  const sync = async (clientId: string) => {
    setBusyKey(`sync:${clientId}`);
    try {
      await api.post(`/clients/${clientId}/accounts/sync`, {});
      await refreshClients();
      setPendingSync((p) => (p === clientId ? null : p));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="screen active" data-screen="settings">
      <div className="topbar">
        <div className="h">
          <h2>Settings</h2>
          <p>App behavior, connected accounts, and your operator session.</p>
        </div>
      </div>
      <div className="stage">
        <div className="card glass setsec">
          <h3>General</h3>
          <div className="sub" style={{ marginBottom: 10 }}>
            Desktop app behavior
          </div>
          <div
            className="pt"
            style={{ maxWidth: 420, opacity: autostart === null ? 0.5 : 1 }}
            onClick={toggleAutostart}
            title={
              autostart === null
                ? "Available when running the desktop app (not browser dev mode)"
                : undefined
            }
          >
            <div className="info">
              <b>Run upon startup</b>
              <span>
                {autostart === null
                  ? isTauri()
                    ? "checking…"
                    : "desktop app only"
                  : autostart
                    ? "On"
                    : "Off"}
              </span>
            </div>
            <div className={`switch${autostart ? " on" : ""}`} style={{ marginLeft: "auto" }} />
          </div>
        </div>

        <div className="card glass setsec">
          <div className="rowhead">
            <div>
              <h3>Connected Accounts</h3>
              <div className="sub">
                One profile per enrolled client. Expand a card for the 30-day overview,
                connect or disconnect platforms, and switch card styles.
              </div>
            </div>
            <span className="link" onClick={onOpenConnect}>
              + Enroll a client
            </span>
          </div>

          {clients.length === 0 ? (
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-users" />
                </svg>
              </div>
              <b>No clients enrolled</b>
              <p>Enroll a client to start connecting their platforms.</p>
            </div>
          ) : (
            <div className="pgrid">
              {clients.map((client) => (
                <ProfileCard
                  key={client.id}
                  client={client}
                  busyKey={busyKey}
                  pending={pendingSync === client.id}
                  onConnect={(p) => void connect(client.id, p)}
                  onDisconnect={(id) => void disconnect(id)}
                  onSync={() => void sync(client.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card glass setsec">
          <h3>Operator</h3>
          <div className="sub" style={{ marginBottom: 12 }}>
            Signed in as {user?.email} · {user?.agencyName}
          </div>
          <button className="btn ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </div>
    </section>
  );
}
