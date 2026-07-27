import { useEffect, useRef, useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
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

/**
 * Contact details for one client, saved on blur.
 *
 * Saving on blur rather than behind a Save button because these are three
 * fields you edit once a year: a button would be one more thing to forget to
 * press, and the value would silently not persist. A field only writes when
 * its value actually changed, so tabbing through does not fire three requests.
 */
function ContactFields({ client, onSaved }: { client: ClientSummary; onSaved(): void }) {
  const toast = useToast();
  const [draft, setDraft] = useState({
    contactName: client.contactName ?? "",
    contactEmail: client.contactEmail ?? "",
    contactPhone: client.contactPhone ?? "",
  });
  const [saving, setSaving] = useState<string | null>(null);

  const FIELDS = [
    { key: "contactName" as const, label: "Contact name", type: "text", placeholder: "Who you deal with" },
    { key: "contactEmail" as const, label: "Best email", type: "email", placeholder: "name@company.com" },
    { key: "contactPhone" as const, label: "Phone", type: "tel", placeholder: "+1 555 0100" },
  ];

  const save = async (key: (typeof FIELDS)[number]["key"]) => {
    const value = draft[key].trim();
    if (value === (client[key] ?? "")) return;
    setSaving(key);
    try {
      await api.patch(`/clients/${client.id}/contact`, { [key]: value });
      onSaved();
    } catch (err) {
      toast.fail(`Could not save the ${key === "contactPhone" ? "phone number" : key === "contactEmail" ? "email" : "contact name"}`, err);
      // Put the stored value back so the field never shows an unsaved edit.
      setDraft((d) => ({ ...d, [key]: client[key] ?? "" }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="pcontact">
      {FIELDS.map((f) => (
        <label className="cfield" key={f.key}>
          <span className="lab">
            {f.label}
            {saving === f.key && <i> saving…</i>}
          </span>
          <input
            className="field-in"
            type={f.type}
            value={draft[f.key]}
            placeholder={f.placeholder}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            onBlur={() => void save(f.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
      ))}
    </div>
  );
}

function ProfileCard({
  client,
  onConnect,
  onDisconnect,
  onSync,
  onContactSaved,
  busyKey,
  pending,
}: {
  client: ClientSummary;
  onConnect(platform: Platform): void;
  onDisconnect(accountId: string): void;
  onSync(): void;
  onContactSaved(): void;
  busyKey: string | null;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cover, setCover] = useState(false);

  const connected = client.accounts.filter((a) => a.status === "connected");
  const avatar = clientAvatarUrl(client);
  const displayName = connected.find((a) => a.displayName)?.displayName ?? client.name;

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
          <ContactFields client={client} onSaved={onContactSaved} />

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
                  {/* Handle truncates rather than growing: @realcalebconcepcion
                      used to push straight through the Disconnect button. */}
                  <span title={account ? `@${account.handle}` : undefined}>
                    <i className={`livedot ${account ? "on" : "off"}`} />
                    {account ? `@${account.handle}` : "not connected"}
                  </span>
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
  const toast = useToast();
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
    } catch (err) {
      toast.fail("Could not change the startup setting", err);
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
    } catch (err) {
      toast.fail(`Could not connect ${PLATFORM_LABELS[platform]}`, err);
    } finally {
      setBusyKey(null);
    }
  };

  const disconnect = async (accountId: string) => {
    setBusyKey(accountId);
    try {
      await api.del(`/accounts/${accountId}`);
      await refreshClients();
    } catch (err) {
      toast.fail("Could not disconnect the account", err);
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
      // A sync that finds nothing new leaves the card looking untouched.
      toast.success("Accounts synced.");
    } catch (err) {
      toast.fail("Could not sync the accounts", err);
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
                One profile per enrolled client. Expand a card to keep their contact
                details, connect or disconnect platforms, and switch card styles.
                Their numbers live under Analytics.
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
                  onContactSaved={() => void refreshClients()}
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
