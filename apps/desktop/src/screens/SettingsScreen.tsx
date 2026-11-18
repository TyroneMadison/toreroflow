import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import DeployCard, { type DeployStatus } from "../components/DeployCard";
import UpdateCard, { serverCheck, type ServerState } from "../components/UpdateCard";
import BusinessCard, { SaveTag, useSaved } from "../components/BusinessCard";
import CaptionBlockCard from "../components/CaptionBlockCard";
import TrelloLabelCard, { COLORS } from "../components/TrelloLabelCard";
import Pf, { type PlatformId } from "../components/Pf";
import BrandAvatar from "../components/BrandAvatar";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { Ic, PhoneHead, Sheet, shareLink } from "../components/analytics/phoneBits";
import { useToast } from "../components/Toasts";
import {
  api,
  type AccountInfo,
  type AgencyBusiness,
  type ClientAnalytics,
  type ClientSummary,
  type LabelMap,
  type PlatformConnection,
} from "../lib/api";
import { clientAvatarUrl, initials } from "../lib/avatar";
import { getAutostart, isTauri, setAutostart } from "../lib/autostart";
import { loadAutomation, setAutomation } from "../lib/theme";
import { loadGlassLevel, setGlassLevel } from "../lib/glass";
import { openExternal } from "../lib/external";
import { useIsPhone } from "../lib/phone";
import { usePhoneBar } from "../lib/phoneBar";
import { linkProps, navigate, SETTINGS_SECTIONS, useRoute } from "../lib/routes";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import { Empty } from "../components/states";

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
  const isPhone = useIsPhone();

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
  if (isPhone)
    return (
      <div className="st-direct">
        <b>Direct data access</b>
        <small>
          <i className={`st-live${connection && !revoked ? "" : " off"}`} />
          <span>
            {!configured
              ? "Not set up on this server"
              : revoked
                ? "Access was withdrawn, send a fresh link"
                : connection
                  ? `${connection.externalName ?? "Channel"} · shares, watch time, subscribers gained`
                  : "Not authorized, so shares and watch time stay blank"}
          </span>
        </small>
        {revoked && connection?.error && <small className="st-faint">{connection.error}</small>}
        {(configured || connection) && (
          <div className="mb-btnrow">
            {configured && (
              <button type="button" className="mb-btn ghost" disabled={busy} onClick={() => void copyLink()}>
                <Ic name="i-copy" />
                {connection ? "Copy new link" : "Copy link"}
              </button>
            )}
            {connection && (
              <button type="button" className="mb-btn st-rem" disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            )}
          </div>
        )}
      </div>
    );
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
  const isPhone = useIsPhone();
  const [savedState, flash] = useSaved();

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
      flash(key, true);
    } catch (err) {
      toast.fail(`Could not save the ${key === "contactPhone" ? "phone number" : key === "contactEmail" ? "email" : "contact name"}`, err);
      // Put the stored value back so the field never shows an unsaved edit.
      setDraft((d) => ({ ...d, [key]: client[key] ?? "" }));
      flash(key, false);
    } finally {
      setSaving(null);
    }
  };

  if (isPhone)
    return (
      <>
        {FIELDS.map((f) => (
          <div className="mb-field" key={f.key}>
            <label className="mb-flab st-flab" htmlFor={`st-${client.id}-${f.key}`}>
              {f.label}
              <SaveTag saving={saving === f.key} state={savedState} k={f.key} />
            </label>
            <input
              id={`st-${client.id}-${f.key}`}
              className="mb-input"
              type={f.type}
              autoComplete="off"
              value={draft[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => void save(f.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        ))}
      </>
    );

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
  const isPhone = useIsPhone();
  const [savedState, flash] = useSaved();

  const savePrice = async () => {
    const stored = client.monthlyPriceCents === null ? "" : (client.monthlyPriceCents / 100).toFixed(2);
    if (dollars.trim() === stored) return;
    const parsed = dollars.trim() === "" ? null : Number.parseFloat(dollars);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.fail(`Could not save ${client.name}'s price`, new Error("enter a valid amount"));
      setDollars(stored);
      flash("price", false);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/clients/${client.id}/billing`, {
        monthlyPriceCents: parsed === null ? null : Math.round(parsed * 100),
      });
      onSaved();
      flash("price", true);
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s price`, err);
      setDollars(stored);
      flash("price", false);
    } finally {
      setSaving(false);
    }
  };

  const saveMode = async (mode: "calendar" | "on_fulfilment") => {
    if (mode === client.billingMode) return;
    try {
      await api.patch(`/clients/${client.id}/billing`, { billingMode: mode });
      onSaved();
      flash("mode", true);
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s billing mode`, err);
      flash("mode", false);
    }
  };

  if (isPhone)
    return (
      <>
        <div className="mb-field">
          <label className="mb-flab st-flab" htmlFor={`st-${client.id}-price`}>
            Monthly price
            <SaveTag saving={saving} state={savedState} k="price" />
          </label>
          <span className="st-money">
            <span aria-hidden="true">$</span>
            <input
              id={`st-${client.id}-price`}
              className="mb-input"
              type="number"
              inputMode="decimal"
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
          </span>
        </div>
        <div className="mb-field">
          <span className="mb-flab st-flab">
            Billing
            <SaveTag saving={false} state={savedState} k="mode" />
          </span>
          <div className="seg" role="radiogroup" aria-label="Billing">
            {(
              [
                ["calendar", "Monthly"],
                ["on_fulfilment", "When delivered"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={client.billingMode === mode}
                className={client.billingMode === mode ? "on" : undefined}
                onClick={() => void saveMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </>
    );

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

/** The welcome link with its token hidden, for the line under the buttons. */
const maskLink = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/=[^&=]+$/, "=\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");

function ProfileCard({
  client,
  index = 0,
  phoneOpen = false,
  onPhoneToggle,
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
  /** Phone: its place in the client list (avatar colour), and whether it is the one open card. */
  index?: number;
  phoneOpen?: boolean;
  onPhoneToggle?(): void;
}) {
  const isPhone = useIsPhone();
  const [openSelf, setOpen] = useState(false);
  const open = isPhone ? phoneOpen : openSelf;
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
  // Phone: how the link last went out, the account whose options are open,
  // and the two questions that ask first.
  const [linkHow, setLinkHow] = useState<"copied" | "shared" | "failed" | null>(null);
  const [menu, setMenu] = useState<AccountInfo | null>(null);
  const [askOff, setAskOff] = useState<AccountInfo | null>(null);
  const [askRemove, setAskRemove] = useState(false);
  const cardRef = useRef<HTMLElement>(null);

  // Opening a card closes the one above it, so keep this header in view.
  useEffect(() => {
    if (!isPhone || !phoneOpen) return;
    const el = cardRef.current;
    const top = document.querySelector(".main")?.getBoundingClientRect().top ?? 0;
    if (el && el.getBoundingClientRect().top < top) el.scrollIntoView({ block: "start" });
  }, [isPhone, phoneOpen]);

  /**
   * This brand's own welcome link, copied ready to send.
   *
   * Minted once and kept, so the same link keeps working however often it is
   * sent. That is the point of it being here rather than only where a client
   * is first added: when someone's accounts drop off months later, they need
   * the same link again, not a new brand.
   */
  const copyWelcomeLink = async (share = false) => {
    setLinkBusy(true);
    try {
      const link = await api.post<{
        url: string;
        connectPublished: boolean;
        note: string | null;
      }>(`/clients/${client.id}/welcome-link`);
      setWelcomeUrl(link.url);
      // The phone can hand it to the share sheet instead (that falls back to copying).
      let how: "copied" | "shared" | "failed" = "copied";
      if (share) how = await shareLink(link.url, `${client.name} welcome link`);
      else await navigator.clipboard.writeText(link.url);
      setLinkHow(how);
      // A link whose page carries no connect buttons is worth sending late
      // rather than silently: the operator must hear it before the client does.
      if (link.note || !link.connectPublished) {
        toast.fail(
          `${client.name}'s page is form-only right now`,
          new Error(link.note ?? "The connect buttons could not be published. Press again in a minute."),
        );
      } else if (how === "copied") {
        toast.success(`Welcome link for ${client.name} copied.`);
      } else if (how === "failed") {
        toast.error("Could not share the link. Press and hold it to copy it.");
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

  if (isPhone) {
    const syncing = busyKey === `sync:${client.id}`;
    const kinds = new Set(connected.map((a) => a.platform)).size;
    const count =
      connected.length === 0
        ? "No platforms yet"
        : connected.length === kinds
          ? `${connected.length} ${connected.length === 1 ? "account" : "accounts"} connected`
          : `${connected.length} accounts on ${kinds} platforms`;
    return (
      <>
        <section
          ref={cardRef}
          className={`mb-card st-bcard${cover ? " cover" : ""}${open ? " open" : ""}`}
          style={cover && avatar ? ({ "--st-cover": `url(${JSON.stringify(avatar)})` } as CSSProperties) : undefined}
          data-testid={`settings.brand.${client.id}`}
        >
          <button
            type="button"
            className="st-bhead"
            aria-expanded={open}
            onClick={onPhoneToggle}
            data-testid={`settings.brand.${client.id}.toggle`}
          >
            <BrandAvatar client={client} index={index} size={52} />
            <span className="st-bt">
              <span className="st-bname">
                <span>{displayName}</span>
                {connected.length > 0 && <Ic name="i-check-circle" />}
              </span>
              <span className="st-bsub">{displayName !== client.name ? `${client.name} · ${count}` : count}</span>
              {connected.length > 0 && (
                <span className="st-bpf">
                  {connected.map((a) => (
                    <Pf key={a.id} p={PF_ID[a.platform]} size="sm" />
                  ))}
                </span>
              )}
            </span>
            <span className="st-chev">
              <Ic name="i-chev" />
            </span>
          </button>
          <div className="st-bacts">
            <button type="button" className="mb-btn sm ghost" disabled={syncing} onClick={onSync}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className={syncing ? "st-spin" : undefined}>
                <use href="#i-refresh" />
              </svg>
              {syncing ? "Syncing" : "Sync"}
            </button>
            <button type="button" className="mb-btn sm ghost" disabled={linkBusy} onClick={() => void copyWelcomeLink()}>
              <Ic name="i-copy" />
              Welcome link
            </button>
            <button
              type="button"
              className="mb-ib"
              aria-label="Switch card style"
              aria-pressed={cover}
              onClick={() => setCover((c) => !c)}
              data-testid={`settings.brand.${client.id}.style`}
            >
              <Ic name="i-image" />
            </button>
          </div>

          {open && (
            <div className="st-bbody">
              {client.handles && Object.keys(client.handles).length > 0 && (
                <div className="st-blk">
                  <span className="mb-lab">Handles they gave</span>
                  <div className="st-handles">
                    {Object.entries(client.handles).map(([platform, handle]) => {
                      const pf = PF_ID[platform as Platform] as PlatformId | undefined;
                      return (
                        <span className="st-hchip" key={platform}>
                          {pf ? <Pf p={pf} size="xs" /> : <span>{platform}:</span>}
                          <b>@{handle}</b>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="st-blk">
                <span className="mb-lab">Contact</span>
                <ContactFields client={client} onSaved={onContactSaved} />
              </div>
              <div className="st-blk">
                <span className="mb-lab">Billing</span>
                <BillingFields client={client} onSaved={onContactSaved} />
              </div>

              <div className="st-blk">
                <div className="st-blkh">
                  <span className="mb-lab">Platforms</span>
                  <button type="button" className="st-link" disabled={syncing} onClick={onSync}>
                    {syncing ? "Syncing" : "Sync accounts"}
                  </button>
                </div>
                {pending && (
                  <div className="mb-banner warn st-ban" role="status">
                    <Ic name="i-clock" />
                    <span className="mb-bt">Finish authorizing in your browser, then tap Sync accounts.</span>
                  </div>
                )}
                <div className="st-plist">
                  {PLATFORMS.map((platform) => {
                    // One row per connected account, as on desktop, so a
                    // second Instagram is its own row.
                    const accounts = client.accounts.filter((a) => a.platform === platform && a.status === "connected");
                    if (accounts.length === 0) {
                      const busy = busyKey === `${client.id}:${platform}`;
                      return (
                        <div className="st-prow" key={platform}>
                          <Pf p={PF_ID[platform]} size="lg" />
                          <span className="mb-lt">
                            <b>{PLATFORM_LABELS[platform]}</b>
                            <small>
                              <i className="st-live off" />
                              <span>Not connected</span>
                            </small>
                          </span>
                          <button type="button" className="mb-btn sm" disabled={busy} onClick={() => onConnect(platform)}>
                            {busy ? "Opening" : "Connect"}
                          </button>
                        </div>
                      );
                    }
                    return accounts.map((account) => (
                      <Fragment key={account.id}>
                        <div className="st-prow">
                          <Pf p={PF_ID[platform]} size="lg" />
                          <span className="mb-lt">
                            <b>{PLATFORM_LABELS[platform]}</b>
                            <small>
                              <i className="st-live" />
                              <span>@{account.handle}</span>
                            </small>
                          </span>
                          <button
                            type="button"
                            className="mb-ib"
                            aria-label={`Options for ${PLATFORM_LABELS[platform]} @${account.handle}`}
                            aria-haspopup="dialog"
                            disabled={busyKey === account.id}
                            onClick={() => setMenu(account)}
                          >
                            <Ic name="i-dots-h" />
                          </button>
                        </div>
                        {platform === "youtube" && !account.reminder && (
                          <DirectConnection
                            accountId={account.id}
                            handle={account.handle}
                            connection={connections.get(account.id)}
                            configured={googleConfigured}
                            onChanged={onConnectionsChanged}
                          />
                        )}
                      </Fragment>
                    ));
                  })}
                </div>
              </div>

              <div className="st-blk">
                <div className="mb-btnrow st-wl">
                  <button type="button" className="mb-btn ghost" disabled={linkBusy} onClick={() => void copyWelcomeLink()}>
                    <Ic name="i-copy" />
                    {linkBusy ? "Getting the link" : "Copy welcome link"}
                  </button>
                  <button type="button" className="mb-btn ghost" disabled={linkBusy} onClick={() => void copyWelcomeLink(true)}>
                    <Ic name="i-share" />
                    Share
                  </button>
                </div>
                {welcomeUrl && (
                  <div className="st-url">
                    <Ic name="i-check" />
                    {linkHow === "shared" ? "Shared" : linkHow === "failed" ? "Link" : "Copied"}{" "}
                    <code>{linkHow === "failed" ? welcomeUrl : maskLink(welcomeUrl)}</code>
                  </div>
                )}
                <p className="st-help">
                  Send it when accounts need connecting or reconnecting. What they do there flows back into the app on
                  its own.
                </p>
              </div>

              <div className="st-blk">
                <button type="button" className="mb-btn ghost block" onClick={() => setRemOpen(true)}>
                  <Ic name="i-plus" />
                  Add a reminder account
                </button>
                <p className="st-help">
                  For personal profiles nothing can post to. At post time the client gets the video and caption by email
                  and posts it themselves.
                </p>
              </div>

              <div className="st-danger">
                <button type="button" className="mb-btn sm" onClick={() => setAskRemove(true)}>
                  <Ic name="i-trash" />
                  Remove {client.name}
                </button>
                <span className="st-help">Takes its posts and reports with it. There is no undo.</span>
              </div>
            </div>
          )}
        </section>

        {menu && (
          <Sheet
            label={`${PLATFORM_LABELS[menu.platform]} @${menu.handle}`}
            title={PLATFORM_LABELS[menu.platform]}
            sub={`@${menu.handle}`}
            onClose={() => setMenu(null)}
            className="st-sheet"
          >
            <div className="mb-card list">
              <button
                type="button"
                className="mb-lrow"
                disabled={busyKey === `${client.id}:${menu.platform}`}
                onClick={() => {
                  const p = menu.platform;
                  setMenu(null);
                  onConnect(p);
                }}
              >
                <span className="mb-lic n">
                  <Ic name="i-plus" />
                </span>
                <span className="mb-lt">
                  <b>Connect another {PLATFORM_LABELS[menu.platform]} account</b>
                </span>
              </button>
              <button
                type="button"
                className="mb-lrow st-badrow"
                onClick={() => {
                  setAskOff(menu);
                  setMenu(null);
                }}
              >
                <span className="mb-lic bad">
                  <Ic name="i-x" />
                </span>
                <span className="mb-lt">
                  <b>Disconnect @{menu.handle}</b>
                </span>
              </button>
            </div>
          </Sheet>
        )}
        {askOff && (
          <ConfirmSheet
            title={`Disconnect @${askOff.handle}?`}
            body={`Toreroflow stops posting to this ${PLATFORM_LABELS[askOff.platform]} account until it is connected again.`}
            confirm="Disconnect"
            danger
            onConfirm={() => {
              const id = askOff.id;
              setAskOff(null);
              onDisconnect(id);
            }}
            onClose={() => setAskOff(null)}
          />
        )}
        {askRemove && (
          <ConfirmSheet
            title={`Remove ${client.name}?`}
            body="Its posts and reports go too. There is no undo."
            confirm="Remove"
            danger
            onConfirm={() => {
              setAskRemove(false);
              onDelete();
            }}
            onClose={() => setAskRemove(false)}
          />
        )}
        {remOpen && (
          <Sheet
            label="Add a reminder account"
            title="Reminder account"
            sub={client.name}
            onClose={() => setRemOpen(false)}
            className="st-sheet"
            foot={
              <>
                <button type="button" className="mb-btn" onClick={() => setRemOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="mb-btn pri"
                  disabled={remBusy || !remHandle.trim()}
                  onClick={() => void addReminder()}
                >
                  {remBusy ? "Adding" : "Add"}
                </button>
              </>
            }
          >
            <p className="st-help">
              For personal profiles nothing can post to. At post time the client gets the video and caption by email and
              posts it themselves.
            </p>
            <label className="mb-field">
              <span className="mb-flab">Platform</span>
              <select className="mb-input" value={remPlatform} onChange={(e) => setRemPlatform(e.target.value as Platform)}>
                {PLATFORMS.map((pf) => (
                  <option key={pf} value={pf}>
                    {PLATFORM_LABELS[pf]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-field">
              <span className="mb-flab">Handle</span>
              <input
                className="mb-input"
                placeholder="handle, e.g. caleb.concepcion"
                autoCapitalize="none"
                autoCorrect="off"
                value={remHandle}
                maxLength={120}
                onChange={(e) => setRemHandle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && remHandle.trim()) void addReminder();
                }}
              />
            </label>
            {remErr && <p className="mb-err">{remErr}</p>}
          </Sheet>
        )}
      </>
    );
  }

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

          {/*
            The welcome link, where reconnecting starts. The same minted-once
            link the client already has: when a platform drops off, copying it
            from right under the account rows and sending it again is the whole
            re-authentication flow, and their taps land back here via the sweep.
          */}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--brd-soft)" }}>
            <button
              className="btn ghost"
              style={{ fontSize: 11.5 }}
              disabled={linkBusy}
              title={`Copy ${client.name}'s welcome link. Send it when accounts need connecting or reconnecting; what they do there flows back into the app on its own.`}
              onClick={() => void copyWelcomeLink()}
            >
              {linkBusy ? "Getting the link…" : "Copy their welcome link (connect / reconnect)"}
            </button>
            {welcomeUrl && (
              <div
                className="sub"
                style={{ fontSize: 11, wordBreak: "break-all", margin: "6px 0 0" }}
                title="Copied. Send this to them."
              >
                {welcomeUrl}
              </div>
            )}
          </div>

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
  const [automation, setAutomationState] = useState(loadAutomation);
  const [glassLevel, setGlassLevelState] = useState(loadGlassLevel);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState<string | null>(null);
  const autoSynced = useRef(new Set<string>());
  const [connections, setConnections] = useState<Map<string, PlatformConnection>>(new Map());
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const isPhone = useIsPhone();
  /** When every brand was last checked for new connections (the phone says so). */
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  /** The phone's one open brand card. */
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void getAutostart().then(setAutostartState);
  }, []);

  // /settings/<section> scrolls that card into view, on load and on back/forward.
  // On the phone each section is its own page, which opens at its top.
  const { section } = useRoute();
  useEffect(() => {
    const el = section ? document.getElementById(`settings-${section}`) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else if (isPhone) document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [section, isPhone]);

  // Phone: a section page gets Back to Settings and its name in the app bar.
  const page = isPhone && section && section !== "general" ? section : null;
  usePhoneBar(
    page
      ? {
          title: SETTINGS_SECTIONS.find((s) => s.id === page)?.label ?? "Settings",
          back: () => navigate("settings"),
          action:
            page === "accounts" ? (
              <button
                type="button"
                className="mb-ib ghost"
                aria-label="Enroll a client"
                onClick={onOpenConnect}
                data-testid="settings.enroll-client.bar"
              >
                <Ic name="i-plus" />
              </button>
            ) : undefined,
        }
      : null,
  );

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
      setSyncedAt(Date.now());
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
          setSyncedAt(Date.now());
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

  const toggleAutomation = () => {
    setAutomation(!automation);
    setAutomationState(!automation);
  };

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

  if (isPhone) {
    const n = clients.length;
    return (
      <section
        key={page ?? "home"}
        className={`screen active mb-page st-page${page ? " st-sec" : ""}`}
        data-screen="settings"
        data-state="ready"
        data-phone-section={page ?? "home"}
      >
        {!page && (
          <PhoneHome
            automation={automation}
            onAutomation={toggleAutomation}
            autostart={autostart}
            autostartBusy={autostartBusy}
            onAutostart={() => void toggleAutostart()}
          />
        )}
        {page === "accounts" && (
          <>
            <p className="st-intro">
              One profile per enrolled client. Open a card for their contact details, billing and platforms. Their
              numbers live under Analytics.
            </p>
            {n > 0 && (
              <div className="st-syncline" role="status">
                {syncedAt ? (
                  <>
                    <Ic name="i-check-circle" />
                    {n === 1 ? "1 brand" : `All ${n} brands`} checked for new connections{" "}
                    {Date.now() - syncedAt < 60_000
                      ? "just now"
                      : `at ${new Date(syncedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="st-spin">
                      <use href="#i-refresh" />
                    </svg>
                    Checking {n === 1 ? "1 brand" : `${n} brands`} for new connections
                  </>
                )}
              </div>
            )}
            {n === 0 ? (
              <div className="mb-empty">
                <span className="mb-ei">
                  <Ic name="i-users" />
                </span>
                <h3>No clients enrolled</h3>
                <p>Enroll a client to start connecting their platforms.</p>
                <button type="button" className="mb-btn pri" onClick={onOpenConnect} data-testid="settings.enroll-client">
                  <Ic name="i-plus" />
                  Enroll a client
                </button>
              </div>
            ) : (
              clients.map((client, i) => (
                <ProfileCard
                  key={client.id}
                  client={client}
                  index={i}
                  phoneOpen={openId === client.id}
                  onPhoneToggle={() => setOpenId((o) => (o === client.id ? null : client.id))}
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
              ))
            )}
            {n > 0 && (
              <button type="button" className="st-addrow" onClick={onOpenConnect} data-testid="settings.enroll-client">
                <Ic name="i-plus" />
                Enroll a client
              </button>
            )}
          </>
        )}
        {page === "business" && <BusinessCard />}
        {page === "trello" && (
          <>
            <TrelloLabelCard />
            <CaptionBlockCard />
          </>
        )}
        {page === "updates" && <UpdateCard />}
        {page === "deploy" && <DeployCard />}
        {page === "operator" && <PhoneOperator />}
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="settings" data-state="ready">
      <div className="topbar">
        <div className="h">
          <h2>Settings</h2>
          <p>App behavior, connected accounts, and your operator session.</p>
        </div>
      </div>
      <div className="stage">
        <div className="card glass setsec" id="settings-general" data-section="general">
          <h3>General</h3>
          <div className="sub" style={{ marginBottom: 10 }}>
            Desktop app behavior
          </div>
          <div
            className="pt"
            style={{ maxWidth: 420, opacity: autostart === null ? 0.5 : 1 }}
            onClick={toggleAutostart}
            data-testid="settings.autostart"
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
          <div className="pt" style={{ maxWidth: 420, marginTop: 8, width: "100%", display: "none" }} hidden>
            <div className="info">
              <b>Glass translucency</b>
              <span>Frosted blur to clear liquid glass. Changes the whole app at once.</span>
            </div>
            <label className="tf-glass-slider">
              <span>Frosted</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={glassLevel}
                aria-label="Glass translucency"
                data-testid="settings.glass-level"
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  setGlassLevel(v);
                  setGlassLevelState(v);
                }}
              />
              <span>Clear</span>
            </label>
          </div>
          <button
            type="button"
            className="pt"
            role="switch"
            aria-checked={automation}
            style={{ maxWidth: 420, marginTop: 8, width: "100%", font: "inherit", color: "inherit", textAlign: "left" }}
            onClick={toggleAutomation}
            data-testid="settings.automation"
          >
            <div className="info">
              <b>Automation mode</b>
              <span>
                No animation and no blur, for bots driving the app. Also on with{" "}
                <span style={{ whiteSpace: "nowrap" }}>?automation=1</span>.
              </span>
            </div>
            <div className={`switch${automation ? " on" : ""}`} style={{ marginLeft: "auto" }} />
          </button>
        </div>

        <div className="card glass setsec" id="settings-accounts" data-section="accounts">
          <div className="rowhead">
            <div>
              <h3>Connected Accounts</h3>
              <div className="sub">
                One profile per enrolled client. Expand a card to keep their contact
                details, connect or disconnect platforms, and switch card styles.
                Their numbers live under Analytics.
              </div>
            </div>
            <span className="link" onClick={onOpenConnect} data-testid="settings.enroll-client">
              + Enroll a client
            </span>
          </div>

          {clients.length === 0 ? (
            <Empty
              screen="settings"
              title="No clients enrolled"
              hint="Enroll a client to start connecting their platforms."
            />
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

        <div id="settings-business" data-section="business">
          <BusinessCard />
        </div>

        <TrelloLabelCard />

        <CaptionBlockCard />

        <div id="settings-updates" data-section="updates">
          <UpdateCard />
        </div>

        <div id="settings-deploy" data-section="deploy">
          <DeployCard />
        </div>

        <div className="card glass setsec" id="settings-operator" data-section="operator">
          <h3>Operator</h3>
          <div className="sub" style={{ marginBottom: 12 }}>
            Signed in as {user?.email} · {user?.agencyName}
          </div>
          <button className="btn ghost" onClick={logout} data-testid="settings.logout">
            Log out
          </button>
        </div>
      </div>
    </section>
  );
}

type Summary = { text: string; tone?: "warn" | "bad" } | null;

/**
 * The phone's Settings home: the seven sections as a grouped list, each with
 * a one-line summary, then General's options inline (it is the first section
 * and has the only options a phone can use). Each summary asks its own
 * question, so a slow one holds up only its own row.
 */
function PhoneHome({
  automation,
  onAutomation,
  autostart,
  autostartBusy,
  onAutostart,
}: {
  automation: boolean;
  onAutomation(): void;
  autostart: boolean | null;
  autostartBusy: boolean;
  onAutostart(): void;
}) {
  const { clients, user } = useAppState();
  const [agency, setAgency] = useState<AgencyBusiness | false | null>(null);
  const [routed, setRouted] = useState<number | false | null>(null);
  const [deploy, setDeploy] = useState<DeployStatus | false | null>(null);
  const [server, setServer] = useState<ServerState | null>(null);
  useEffect(() => {
    void api.get<AgencyBusiness>("/agency").then(setAgency, () => setAgency(false));
    void api.get<LabelMap>("/clients/label-map").then(
      (m) => setRouted(new Set(m.entries.map((e) => e.color).filter((c) => COLORS.includes(c))).size),
      () => setRouted(false),
    );
    void api.get<DeployStatus>("/deploy/status").then(setDeploy, () => setDeploy(false));
    // The same check Updates runs, so "behind main" shows here first.
    void serverCheck().then((r) => setServer(r.state));
  }, []);

  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const line = (s: Summary) =>
    s ? <small className={s.tone}>{s.text}</small> : <small><i className="st-skel" data-state="loading" /></small>;
  const accounts = clients.reduce((t, c) => t + c.accounts.filter((a) => a.status === "connected").length, 0);
  const last = deploy ? deploy.last : null;

  const rows: Array<{ id: "accounts" | "business" | "trello"; icon: string; title: string; sum: Summary }> = [
    {
      id: "accounts",
      icon: "i-users",
      title: "Connected Accounts",
      sum: clients.length
        ? { text: `${plural(clients.length, "brand")}, ${plural(accounts, "account")} connected` }
        : { text: "No clients enrolled", tone: "warn" },
    },
    {
      id: "business",
      icon: "i-bank",
      title: "Business",
      sum:
        agency === null
          ? null
          : agency === false
            ? { text: "Could not load" }
            : { text: `${agency.legalName || "No registered name"}, ${agency.accountingMethod ?? "cash"} accounting` },
    },
    {
      id: "trello",
      icon: "i-trello",
      title: "Trello labels",
      sum: routed === null ? null : { text: routed === false ? "Caption blocks" : `${plural(routed, "color")} routed, caption blocks` },
    },
  ];
  const updates: Summary =
    !server || server.kind === "unknown"
      ? null
      : server.kind === "behind"
        ? { text: "Server is behind main", tone: "warn" }
        : server.kind === "current"
          ? { text: "Server is up to date" }
          : server.kind === "not-deployed"
            ? { text: "No server version to compare" }
            : { text: "Could not check" };
  const ship: Summary =
    deploy === null
      ? null
      : deploy === false
        ? { text: "Could not check" }
        : !deploy.available
          ? { text: "Nothing to deploy to" }
          : !last
            ? { text: "No deploys yet" }
            : last.status === "running"
              ? { text: "Deploying" }
              : last.status === "success"
                ? { text: `Last deploy succeeded ${day(last.finishedAt ?? last.startedAt)}` }
                : { text: `Last deploy failed ${day(last.finishedAt ?? last.startedAt)}`, tone: "bad" };

  return (
    <>
      <PhoneHead screen="settings" sub="App behavior, connected accounts, and your operator session." />
      <section className="mb-card list st-list">
        <button
          type="button"
          className="mb-lrow"
          onClick={() => document.getElementById("settings-general")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          data-testid="settings.row.general"
        >
          <span className="mb-lic n">
            <Ic name="i-gear" />
          </span>
          <span className="mb-lt">
            <b>General</b>
            <small>Automation mode {automation ? "on" : "off"}</small>
          </span>
          <span className="st-tr">
            Below
            <Ic name="i-chev" />
          </span>
        </button>
        {rows.map((r) => (
          <a key={r.id} className="mb-lrow" {...linkProps("settings", r.id)} data-testid={`settings.row.${r.id}`}>
            <span className="mb-lic n">
              <Ic name={r.icon} />
            </span>
            <span className="mb-lt">
              <b>{r.title}</b>
              {line(r.sum)}
            </span>
            <Ic name="i-chev-r" />
          </a>
        ))}
      </section>

      <section className="mb-card list st-list">
        <a className="mb-lrow" {...linkProps("settings", "updates")} data-testid="settings.row.updates">
          <span className="mb-lic n">
            <Ic name="i-refresh" />
          </span>
          <span className="mb-lt">
            <b>Updates</b>
            {line(updates)}
          </span>
          <span className="st-tr">
            {server?.kind === "behind" && <i className="st-dot" aria-hidden="true" />}
            <Ic name="i-chev-r" />
          </span>
        </a>
        <a className="mb-lrow" {...linkProps("settings", "deploy")} data-testid="settings.row.deploy">
          <span className="mb-lic n">
            <Ic name="i-rocket" />
          </span>
          <span className="mb-lt">
            <b>Ship an update</b>
            {line(ship)}
          </span>
          <Ic name="i-chev-r" />
        </a>
      </section>

      <section className="mb-card list st-list">
        <a className="mb-lrow" {...linkProps("settings", "operator")} data-testid="settings.row.operator">
          <span className="st-av" aria-hidden="true">
            {initials(user?.agencyName ?? "")}
          </span>
          <span className="mb-lt">
            <b>Operator</b>
            <small>
              {user?.email} · {user?.agencyName}
            </small>
          </span>
          <Ic name="i-chev-r" />
        </a>
      </section>

      <div className="st-grp" id="settings-general">
        <span className="mb-lab">General</span>
        <section className="mb-card st-opts">
          <button
            type="button"
            className="st-opt"
            role="switch"
            aria-checked={automation}
            onClick={onAutomation}
            data-testid="settings.automation"
          >
            <span className="mb-lt">
              <b>Automation mode</b>
              <small>
                No animation and no blur, for bots driving the app. Also on with <code>?automation=1</code>.
              </small>
            </span>
            <span className={`mb-tog${automation ? " on" : ""}`} aria-hidden="true" />
          </button>
          {isTauri() ? (
            <button
              type="button"
              className="st-opt"
              role="switch"
              aria-checked={!!autostart}
              disabled={autostart === null || autostartBusy}
              onClick={onAutostart}
              data-testid="settings.autostart"
            >
              <span className="mb-lt">
                <b>Run upon startup</b>
                <small>{autostart === null ? "Checking" : "Opens Toreroflow when your PC starts."}</small>
              </span>
              <span className={`mb-tog${autostart ? " on" : ""}`} aria-hidden="true" />
            </button>
          ) : (
            <div className="st-opt dim" data-testid="settings.autostart">
              <span className="mb-lt">
                <b>Run upon startup</b>
                <small>Opens Toreroflow when your PC starts.</small>
              </span>
              <span className="mb-pill nodot">
                <Ic name="i-desktop" />
                Desktop app only
              </span>
            </div>
          )}
        </section>
      </div>

      {!isTauri() && (
        <p className="st-foot">
          Toreroflow web app on this phone. It runs whatever the server runs
          {deploy && deploy.current ? `, now ${deploy.current.slice(0, 7)}` : ""}.
        </p>
      )}
    </>
  );
}

/** The phone's Operator page: who is signed in, on what, and Log out (which asks first). */
function PhoneOperator() {
  const { user, logout } = useAppState();
  const [ask, setAsk] = useState(false);
  // ponytail: a user agent sniff for one label; names the common browsers only.
  const ua = navigator.userAgent;
  const browser = /Edg/.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const where = isTauri() ? "The desktop app" : /Mobi|iPhone|Android/.test(ua) ? "This phone" : "This browser";
  return (
    <>
      <section className="mb-card st-me">
        <span className="st-av" aria-hidden="true">
          {initials(user?.agencyName ?? "")}
        </span>
        <b>{user?.agencyName}</b>
        <span className="st-muted">{user?.email}</span>
        <span className="mb-pill acc nodot">{user?.role === "viewer" ? "Viewer" : "Owner"}</span>
      </section>
      <section className="mb-card st-kvs">
        <div className="st-kv">
          <span>Agency</span>
          <b>{user?.agencyName}</b>
        </div>
        <div className="st-kv">
          <span>Signed in on</span>
          <b>{browser && !isTauri() ? `${where}, ${browser}` : where}</b>
        </div>
        <div className="st-kv">
          <span>Session</span>
          <b>Stays signed in</b>
        </div>
      </section>
      <div className="st-out">
        <button type="button" className="mb-btn danger block lg" onClick={() => setAsk(true)} data-testid="settings.logout">
          <Ic name="i-logout" />
          Log out
        </button>
        <p className="st-center">Asks first. Scheduled posts keep going out after you log out.</p>
      </div>
      {ask && (
        <ConfirmSheet
          title="Log out?"
          body="You will need your email and password to sign in again on this phone."
          confirm="Log out"
          danger
          onConfirm={logout}
          onClose={() => setAsk(false)}
        />
      )}
    </>
  );
}
