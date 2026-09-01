import { useEffect, useRef, useState } from "react";
import DeployCard from "../components/DeployCard";
import UpdateCard from "../components/UpdateCard";
import BusinessCard from "../components/BusinessCard";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import {
  api,
  type ClientAnalytics,
  type ClientSummary,
  type PlatformConnection,
} from "../lib/api";
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
 * The direct platform credential, alongside the publishing connection above it
 * rather than instead of it.
 *
 * A separate row on purpose. "Connected" on the row above means the app can
 * post there, which is a different fact from whether the channel owner has let
 * us read the numbers only they can see, and one screen that blurred the two
 * would make an unread channel look fully wired up.
 *
 * The link is copied rather than opened, because the person who has to click it
 * is almost never the person looking at this screen. Caleb owns Caleb's
 * channel; opening it here would authorize whatever channel the operator
 * happens to be signed into, which the callback then refuses.
 */
function DirectConnection({
  accountId,
  handle,
  connection,
  configured,
  onChanged,
}: {
  accountId: string;
  handle: string;
  connection: PlatformConnection | undefined;
  configured: boolean;
  onChanged(): void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const copyLink = async () => {
    setBusy(true);
    try {
      const { authUrl, expectWarning, expiresInDays } = await api.post<{
        authUrl: string;
        expectWarning: string;
        expiresInDays: number;
      }>(`/oauth/google/start/${accountId}`);
      await navigator.clipboard.writeText(authUrl);
      toast.success(
        `Authorization link for @${handle} copied, good for ${expiresInDays} days. ${expectWarning}`,
      );
    } catch (err) {
      toast.fail("Could not create the authorization link", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/oauth/connections/${accountId}`);
      toast.success("Direct access removed. Posting is unaffected.");
      onChanged();
    } catch (err) {
      toast.fail("Could not remove direct access", err);
    } finally {
      setBusy(false);
    }
  };

  const revoked = connection?.status === "revoked";
  return (
    <div className="connect-row" style={{ paddingLeft: 34, opacity: 0.95 }}>
      <div className="cinfo">
        <b style={{ fontSize: 11.5 }}>Direct data access</b>
        <span title={connection?.error ?? undefined}>
          <i className={`livedot ${connection && !revoked ? "on" : "off"}`} />
          {!configured
            ? "not set up on this server"
            : revoked
              ? "access was withdrawn, send a fresh link"
              : connection
                ? `${connection.externalName ?? "channel"} · shares, watch time, subscribers gained`
                : "not authorized, so shares and watch time stay blank"}
        </span>
      </div>
      {configured && (
        <button className="cbtn" disabled={busy} onClick={() => void copyLink()}>
          {busy ? "…" : connection ? "Copy new link" : "Copy link"}
        </button>
      )}
      {connection && (
        <button className="dangerbtn" disabled={busy} onClick={() => void remove()}>
          {busy ? "…" : "Remove"}
        </button>
      )}
    </div>
  );
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
  connections,
  googleConfigured,
  onConnectionsChanged,
}: {
  client: ClientSummary;
  onConnect(platform: Platform): void;
  onDisconnect(accountId: string): void;
  onSync(): void;
  onContactSaved(): void;
  onDelete(): void;
  busyKey: string | null;
  pending: boolean;
  connections: Map<string, PlatformConnection>;
  googleConfigured: boolean;
  onConnectionsChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  const [cover, setCover] = useState(false);
  // The add-a-reminder-account form: platform + handle, no OAuth, because
  // there is nothing to authorize on a personal profile.
  const [remOpen, setRemOpen] = useState(false);
  const [remPlatform, setRemPlatform] = useState<Platform>("facebook");
  const [remHandle, setRemHandle] = useState("");
  const [remBusy, setRemBusy] = useState(false);
  const [remErr, setRemErr] = useState<string | null>(null);
  const addReminder = async () => {
    setRemBusy(true);
    setRemErr(null);
    try {
      await api.post(`/clients/${client.id}/accounts/reminder`, {
        platform: remPlatform,
        handle: remHandle,
      });
      setRemOpen(false);
      setRemHandle("");
      onContactSaved();
    } catch (e: unknown) {
      setRemErr(e instanceof Error ? e.message : "could not add the account");
    } finally {
      setRemBusy(false);
    }
  };
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
      const link = await api.post<{
        url: string;
        connectPublished: boolean;
        note: string | null;
      }>(`/clients/${client.id}/welcome-link`);
      setWelcomeUrl(link.url);
      await navigator.clipboard.writeText(link.url);
      // A link whose page carries no connect buttons is worth sending late
      // rather than silently: the operator must hear it before the client does.
      if (link.note || !link.connectPublished) {
        toast.fail(
          `${client.name}'s page is form-only right now`,
          new Error(link.note ?? "The connect buttons could not be published. Press again in a minute."),
        );
      } else {
        toast.success(`Welcome link for ${client.name} copied.`);
      }
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
          {/*
            Checking whether they have connected yet is the thing done most
            often while waiting on a client, so it sits on the card rather than
            inside the expanded view.
          */}
          <div
            className="iconbtn pstyle"
            title={
              busyKey === `sync:${client.id}`
                ? "Checking"
                : `Check whether ${client.name} has connected any accounts`
            }
            onClick={onSync}
          >
            <svg>
              <use href="#i-refresh" />
            </svg>
          </div>
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
          {/*
            What they said their own accounts are, from their welcome form.
            Shown apart from the connected platforms above because these cannot
            post: this is how a platform nobody had yet becomes known, and the
            connect tap is what makes it postable.
          */}
          {client.handles && Object.keys(client.handles).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <span className="lab">Handles they gave</span>
              <div className="pplat" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                {Object.entries(client.handles).map(([platform, handle]) => (
                  <span key={platform} style={{ fontSize: 11.5, color: "var(--txt-3)" }}>
                    {platform}: <b style={{ color: "var(--txt-2)" }}>@{handle}</b>
                  </span>
                ))}
              </div>
            </div>
          )}

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
            // Every connected account on this platform gets its own row, so a
            // brand with two Facebook pages can see both and disconnect either.
            // "find" here is how the second page used to be invisible.
            const platformAccounts = client.accounts.filter(
              (a) => a.platform === platform && a.status === "connected",
            );
            if (platformAccounts.length === 0) {
              const key = `${client.id}:${platform}`;
              const busy = busyKey === key;
              return (
                <div className="connect-row" key={platform}>
                  <Pf p={PF_ID[platform]} />
                  <div className="cinfo">
                    <b>{PLATFORM_LABELS[platform]}</b>
                    <span>
                      <i className="livedot off" />
                      not connected
                    </span>
                  </div>
                  <button className="cbtn" disabled={busy} onClick={() => onConnect(platform)}>
                    {busy ? "…" : "Connect"}
                  </button>
                </div>
              );
            }
            return platformAccounts.map((account, i) => {
              const busy = busyKey === account.id;
              return (
                <div key={account.id}>
                  <div className="connect-row">
                    <Pf p={PF_ID[platform]} />
                    <div className="cinfo">
                      <b>{PLATFORM_LABELS[platform]}</b>
                      {/* Handle truncates rather than growing: @examplecreator
                          used to push straight through the Disconnect button. */}
                      <span title={`@${account.handle}`}>
                        <i className="livedot on" />@{account.handle}
                      </span>
                    </div>
                    {/* One "add another" per platform, on the last row, so a
                        second page of the same platform is a first-class thing
                        rather than something Zernio does behind the app's back. */}
                    {i === platformAccounts.length - 1 && (
                      <button
                        className="cbtn"
                        title={`Connect another ${PLATFORM_LABELS[platform]} account`}
                        disabled={busyKey === `${client.id}:${platform}`}
                        onClick={() => onConnect(platform)}
                      >
                        + Add
                      </button>
                    )}
                    <button
                      className="dangerbtn"
                      disabled={busy}
                      onClick={() => onDisconnect(account.id)}
                    >
                      {busy ? "…" : "Disconnect"}
                    </button>
                  </div>
                  {/* YouTube only for now: it is the one platform whose direct
                      OAuth exists. Meta and TikTok get the same row when their
                      apps are live. A reminder account is skipped, because there
                      is no channel behind it to authorize. */}
                  {platform === "youtube" && !account.reminder && (
                    <DirectConnection
                      accountId={account.id}
                      handle={account.handle}
                      connection={connections.get(account.id)}
                      configured={googleConfigured}
                      onChanged={onConnectionsChanged}
                    />
                  )}
                </div>
              );
            });
          })}

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--brd-soft)" }}>
            {!remOpen ? (
              <button
                className="btn ghost"
                style={{ fontSize: 11.5 }}
                title="For personal profiles nothing can post to: at post time the client gets the video and caption by email and posts it themselves."
                onClick={() => setRemOpen(true)}
              >
                + Add a reminder account (posts by hand)
              </button>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  className="field-in"
                  style={{ width: 130 }}
                  value={remPlatform}
                  onChange={(e) => setRemPlatform(e.target.value as Platform)}
                >
                  {PLATFORMS.map((pf) => (
                    <option key={pf} value={pf}>
                      {PLATFORM_LABELS[pf]}
                    </option>
                  ))}
                </select>
                <input
                  className="field-in"
                  style={{ width: 180 }}
                  placeholder="handle, e.g. caleb.concepcion"
                  value={remHandle}
                  maxLength={120}
                  onChange={(e) => setRemHandle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && remHandle.trim()) void addReminder();
                  }}
                />
                <button className="cbtn" disabled={remBusy || !remHandle.trim()} onClick={() => void addReminder()}>
                  {remBusy ? "…" : "Add"}
                </button>
                <button className="btn ghost" style={{ fontSize: 11.5 }} onClick={() => setRemOpen(false)}>
                  Cancel
                </button>
                {remErr && <span style={{ fontSize: 11.5, color: "var(--red)" }}>{remErr}</span>}
              </div>
            )}
          </div>
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
  const [connections, setConnections] = useState<Map<string, PlatformConnection>>(new Map());
  const [googleConfigured, setGoogleConfigured] = useState(false);

  useEffect(() => {
    void getAutostart().then(setAutostartState);
  }, []);

  /**
   * Which accounts have a direct credential.
   *
   * Its own request rather than a field on the client list, because it answers
   * a different question from "can we post here" and the two go stale on
   * different clocks: publishing connections change when the operator connects
   * one, these change when a client somewhere else clicks a link.
   *
   * A failure is silent and leaves the map empty, which renders as "not
   * authorized" everywhere. That is the honest reading of not knowing, and this
   * screen has plenty else to do.
   */
  const loadConnections = useRef(async () => {
    try {
      const res = await api.get<{
        connections: PlatformConnection[];
        googleConfigured: boolean;
      }>("/oauth/connections");
      setConnections(new Map(res.connections.map((c) => [c.socialAccountId, c])));
      setGoogleConfigured(res.googleConfigured);
    } catch {
      // The rest of Settings works without this.
    }
  }).current;

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

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

  /*
   * Coming back to the window re-checks every brand.
   *
   * The latch above only fires once per visit, so a client who connects their
   * account while this screen is open would not appear until it was left and
   * reopened. Waiting on someone to tap a link is exactly when this screen is
   * sat on, so returning to the window is the moment to look again.
   *
   * Single-flight: two interleaved syncs can duplicate account rows server
   * side. A ref, not state, because the listener would close over a stale one.
   */
  const focusSyncing = useRef(false);
  useEffect(() => {
    const onFocus = () => {
      if (focusSyncing.current || !clients.length) return;
      focusSyncing.current = true;
      void (async () => {
        try {
          for (const c of clients) {
            try {
              await api.post(`/clients/${c.id}/accounts/sync`, {});
            } catch {
              // A provider outage must not stop the rest, and the button is
              // still there. Silent on purpose: nobody asked for this one.
            }
          }
          await refreshClients();
          // A client authorizing happens on their machine, not this one, so
          // there is nothing to poll for. Coming back to the window is the
          // moment the operator is asking "did they do it yet".
          await loadConnections();
        } finally {
          focusSyncing.current = false;
        }
      })();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clients, refreshClients, loadConnections]);

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
                  connections={connections}
                  googleConfigured={googleConfigured}
                  onConnectionsChanged={() => void loadConnections()}
                />
              ))}
            </div>
          )}
        </div>

        <BusinessCard />

        <UpdateCard />

        <DeployCard />

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
