import { useEffect, useState } from "react";
import Pf from "../components/Pf";
import { api } from "../lib/api";
import { getAutostart, isTauri, setAutostart } from "../lib/autostart";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface SettingsScreenProps {
  onOpenConnect(): void;
}

export default function SettingsScreen({ onOpenConnect }: SettingsScreenProps) {
  const { clients, refreshClients, user, logout } = useAppState();
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState<string | null>(null);

  useEffect(() => {
    void getAutostart().then(setAutostartState);
  }, []);

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
        // Real provider: finish OAuth in the browser, then sync back.
        await openExternal(res.authUrl);
        setPendingSync(clientId);
      } else {
        await refreshClients();
      }
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

  const disconnect = async (accountId: string) => {
    setBusyKey(accountId);
    try {
      await api.del(`/accounts/${accountId}`);
      await refreshClients();
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
                One profile per enrolled client - connect or disconnect each platform.
                Connections run in dry-run mode until a publishing provider is configured.
              </div>
            </div>
            <span className="link" onClick={onOpenConnect}>
              + Enroll a client
            </span>
          </div>

          {clients.length === 0 && (
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-users" />
                </svg>
              </div>
              <b>No clients enrolled</b>
              <p>Enroll a client to start connecting their platforms.</p>
            </div>
          )}

          {clients.map((client) => (
            <div key={client.id} style={{ marginTop: 14 }}>
              <div
                className="flabel"
                style={{ display: "flex", gap: 12, alignItems: "center" }}
              >
                {client.name}
                <span
                  className="link"
                  style={{ textTransform: "none", letterSpacing: 0 }}
                  onClick={() => void sync(client.id)}
                >
                  {busyKey === `sync:${client.id}` ? "Syncing…" : "Sync accounts"}
                </span>
              </div>
              {pendingSync === client.id && (
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
                      <button
                        className="dangerbtn"
                        disabled={busy}
                        onClick={() => void disconnect(account.id)}
                      >
                        {busy ? "…" : "Disconnect"}
                      </button>
                    ) : (
                      <button
                        className="cbtn"
                        disabled={busy}
                        onClick={() => void connect(client.id, platform)}
                      >
                        {busy ? "…" : "Connect"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
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
