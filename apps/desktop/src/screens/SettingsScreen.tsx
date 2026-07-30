import { useEffect, useRef, useState } from "react";
import BusinessCard from "../components/BusinessCard";
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

/**
 * The standing price and billing mode, saved on blur like the contact
 * fields. Changing the price never rewrites months that already seeded;
 * only future months pick it up, which is why this lives in Settings and
 * the per-month number lives on the Financials screen.
 */
function BillingFields({ client, onSaved }: { client: ClientSummary; onSaved(): void }) {
  const toast = useToast();
  const [dollars, setDollars] = useState(
    client.monthlyPriceCents === null ? "" : (client.monthlyPriceCents / 100).toFixed(2),
  );
  const [saving, setSaving] = useState(false);

  const savePrice = async () => {
    const stored = client.monthlyPriceCents === null ? "" : (client.monthlyPriceCents / 100).toFixed(2);
    if (dollars.trim() === stored) return;
    const parsed = dollars.trim() === "" ? null : Number.parseFloat(dollars);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.fail(`Could not save ${client.name}'s price`, new Error("enter a valid amount"));
      setDollars(stored);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/clients/${client.id}/billing`, {
        monthlyPriceCents: parsed === null ? null : Math.round(parsed * 100),
      });
      onSaved();
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s price`, err);
      setDollars(stored);
    } finally {
      setSaving(false);
    }
  };

  const saveMode = async (mode: "calendar" | "on_fulfilment") => {
    if (mode === client.billingMode) return;
    try {
      await api.patch(`/clients/${client.id}/billing`, { billingMode: mode });
      onSaved();
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s billing mode`, err);
    }
  };

  return (
    <div className="pcontact">
      <label className="cfield">
        <span className="lab">
          Monthly price
          {saving && <i> saving…</i>}
        </span>
        <div className="pricein">
          <span>$</span>
          <input
            className="field-in"
            type="number"
            min="0"
            step="0.01"
            placeholder="not billed"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            onBlur={() => void savePrice()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
      </label>
      <label className="cfield">
        <span className="lab">Billing</span>
        <div className="modepick">
          <button
            className={client.billingMode === "calendar" ? "on" : ""}
            onClick={() => void saveMode("calendar")}
          >
            Monthly
          </button>
          <button
            className={client.billingMode === "on_fulfilment" ? "on" : ""}
            onClick={() => void saveMode("on_fulfilment")}
          >
            When delivered
          </button>
        </div>
      </label>
    </div>
  );
}

function ProfileCard({
  client,
  onConnect,
  onDisconnect,
  onSync,
  onContactSaved,
  onDelete,
  busyKey,
  pending,
}: {
  client: ClientSummary;
  onConnect(platform: Platform): void;
  onDisconnect(accountId: string): void;
  onSync(): void;
  onContactSaved(): void;
  onDelete(): void;
  busyKey: string | null;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cover, setCover] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [welcomeUrl, setWelcomeUrl] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const toast = useToast();

  /**
   * This brand's own welcome link, copied ready to send.
   *
   * Minted once and kept, so the same link keeps working however often it is
   * sent. That is the point of it being here rather than only where a client
   * is first added: when someone's accounts drop off months later, they need
   * the same link again, not a new brand.
   */
  const copyWelcomeLink = async () => {
    setLinkBusy(true);
    try {
      const link = await api.post<{ url: string }>(`/clients/${client.id}/welcome-link`);
      setWelcomeUrl(link.url);
      await navigator.clipboard.writeText(link.url);
      toast.success(`Welcome link for ${client.name} copied.`);
    } catch (err) {
      toast.fail(`Could not get ${client.name}'s welcome link`, err);
    } finally {
      setLinkBusy(false);
    }
  };

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
        {welcomeUrl && (
          <div
            className="sub"
            style={{ fontSize: 11, wordBreak: "break-all", margin: "2px 0 8px" }}
            title="Copied. Send this to them."
          >
            {welcomeUrl}
          </div>
        )}
        <div className="pactions">
          <button className="btn pexp" onClick={() => setOpen((o) => !o)}>
            {open ? "Collapse" : "Expand"}
          </button>
          <div
            className="iconbtn pstyle"
            title={
              linkBusy
                ? "Getting the link"
                : `Copy ${client.name}'s welcome link, for them to fill in their details or reconnect their accounts`
            }
            onClick={() => {
              if (!linkBusy) void copyWelcomeLink();
            }}
          >
            <svg>
              <use href="#i-copy" />
            </svg>
          </div>
          <div
            className="iconbtn pstyle"
            title="Switch card style"
            onClick={() => setCover((c) => !c)}
          >
            <svg>
              <use href="#i-image" />
            </svg>
          </div>
          {/* Two-step, because removing a brand takes its posts and reports
              with it and there is no undo. */}
          <div
            className="iconbtn pstyle"
            style={confirming ? { color: "var(--red)", borderColor: "rgba(255,107,122,.4)" } : undefined}
            title={confirming ? "Click again to remove this brand" : "Remove brand"}
            onClick={() => {
              if (confirming) onDelete();
              else {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 3000);
              }
            }}
          >
            {confirming ? (
              <span style={{ fontSize: 9, fontWeight: 700 }}>SURE?</span>
            ) : (
              <svg>
                <use href="#i-x" />
              </svg>
            )}
          </div>
        </div>
      </div>

      <div className="pexpand">
        <div className="pexpand-inner">
          <ContactFields client={client} onSaved={onContactSaved} />
          <BillingFields client={client} onSaved={onContactSaved} />

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
  const autoSynced = useRef(new Set<string>());

  useEffect(() => {
    void getAutostart().then(setAutostartState);
  }, []);

  // Pull provider-side connections in automatically when Settings opens,
  // and again for any client that appears while it stays open. The latch is
  // per client id, so enrolling a brand mid-visit still gets its sync; the
  // ids are added before the requests so the refresh at the end cannot
  // retrigger the effect into a loop.
  useEffect(() => {
    const unsynced = clients.filter((c) => !autoSynced.current.has(c.id));
    if (!unsynced.length) return;
    for (const c of unsynced) autoSynced.current.add(c.id);
    void (async () => {
      for (const client of unsynced) {
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

  /**
   * Remove a brand. Moved here from the Accounts screen when that merged into
   * Settings, since this is now the one place a client is managed.
   */
  const removeClient = async (clientId: string) => {
    const name = clients.find((c) => c.id === clientId)?.name ?? "the brand";
    setBusyKey(`del:${clientId}`);
    try {
      await api.del(`/clients/${clientId}`);
      await refreshClients();
      toast.success(`${name} removed.`);
    } catch (err) {
      toast.fail(`Could not remove ${name}`, err);
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
                  onDelete={() => void removeClient(client.id)}
                />
              ))}
            </div>
          )}
        </div>

        <BusinessCard />

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
