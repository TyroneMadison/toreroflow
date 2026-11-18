import { useEffect, useRef, useState } from "react";
import { DRIVE_CHECK_MINUTES, DRIVE_DEFAULT_PER_DAY, driveRunState, readDriveSource } from "@toreroflow/core";
import { useToast } from "./Toasts";
import {
  api,
  checkDriveFolder,
  getDriveSource,
  saveDriveSource,
  type ClientSummary,
  type DriveFolderCheck,
  type DriveSourceSave,
  type DriveSourceView,
} from "../lib/api";
import { openExternal } from "../lib/external";
import { useAppState } from "../state/AppState";
import { useIsPhone } from "../lib/phone";
import { Ic, PickSheet } from "./analytics/phoneBits";
import { Stepper } from "./mobile/FlowBits";
import ConfirmSheet from "./mobile/ConfirmSheet";
import Pf from "./Pf";

/** The phone's pill tone for each desktop tag colour. */
const PILL_TONE: Record<string, string> = { due: "info", ok: "ok", warn: "warn", miss: "bad" };

/** One pill per DriveImport status, in the tag colours the Financials rows use. */
const DRIVE_STATUS: Record<string, { label: string; tag: string }> = {
  claimed: { label: "Claimed", tag: "due" },
  downloaded: { label: "Downloaded", tag: "due" },
  dryrun: { label: "Test only", tag: "ok" },
  scheduled: { label: "Scheduled", tag: "ok" },
  held: { label: "Held", tag: "warn" },
  skipped: { label: "Skipped", tag: "warn" },
  failed: { label: "Failed", tag: "miss" },
};

/**
 * Drive auto-post: new videos in the client's shared Drive folder post to each
 * ticked Instagram account as trial reels, captioned by AI from the video.
 *
 * Saved behind a button rather than on blur, because saving a link starts
 * posts to a client's account.
 */
export default function DriveAutoPost({ client }: { client: ClientSummary }) {
  const toast = useToast();
  const { refreshClients } = useAppState();
  const [view, setView] = useState<DriveSourceView | null>(null);
  const [form, setForm] = useState<DriveSourceSave>({
    link: "",
    socialAccountIds: [],
    graduation: "MANUAL",
    // There is no practice mode or on switch on this card: a saved link with an
    // account ticked posts, and a cleared link stops. Both are set at Save.
    mode: "live",
    on: false,
    dailyLimit: null,
  });
  const [busy, setBusy] = useState<"save" | "check" | "connect" | "copy" | "sync" | null>(null);
  // An Instagram connect was opened in the browser and is waiting on Sync accounts.
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<DriveFolderCheck | null>(null);
  const isPhone = useIsPhone();
  // Phone: the Graduation picker, the Stop confirm, and all recent videos shown.
  const [pickGrad, setPickGrad] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [allVideos, setAllVideos] = useState(false);
  const tick = (id: string, on: boolean) =>
    setForm((f) => ({
      ...f,
      socialAccountIds: on ? [...f.socialAccountIds.filter((x) => x !== id), id] : f.socialAccountIds.filter((x) => x !== id),
    }));

  const apply = (v: DriveSourceView) => {
    // A server from before several accounts could be ticked sends one id, not a list.
    const s = readDriveSource(v.settings);
    const ids = v.instagramAccounts.map((a) => a.id);
    setView({ ...v, settings: s });
    setForm({
      link: s.link,
      // An account that has since disconnected reads as unticked, so a save
      // never sends one the API refuses, and never moves the trial reels to
      // another account nobody ticked. Only a first setup ticks the one there is.
      socialAccountIds:
        !s.socialAccountIds.length && ids.length === 1 ? [ids[0]!] : s.socialAccountIds.filter((id) => ids.includes(id)),
      graduation: s.graduation,
      mode: "live",
      on: s.on,
      dailyLimit: s.dailyLimit,
    });
  };

  useEffect(() => {
    getDriveSource(client.id).then(apply, (err) => toast.fail(`Could not load ${client.name}'s Drive auto-post`, err));
  }, [client.id, client.name, toast]);

  /*
   * The status, counts and recent videos stay current while this is open, so
   * "is it running" is answered without a reload. The form and the account
   * list are left alone: nothing typed is lost, and the igKey effect owns accounts.
   */
  useEffect(() => {
    const t = setInterval(
      () =>
        getDriveSource(client.id).then(
          (v) => setView((cur) => cur && { ...v, settings: readDriveSource(v.settings), instagramAccounts: cur.instagramAccounts }),
          () => {
            // A missed refresh just waits for the next one.
          },
        ),
      30_000,
    );
    return () => clearInterval(t);
  }, [client.id]);

  /*
   * A newly connected Instagram account (after Sync accounts) shows up to tick
   * without a reload. Only the account list is refreshed, so nothing typed into
   * the form is lost.
   */
  const igKey = client.accounts
    .filter((a) => a.platform === "instagram" && a.status === "connected")
    .map((a) => a.id)
    .sort()
    .join(",");
  const loadedKey = useRef(igKey);
  useEffect(() => {
    if (!view || loadedKey.current === igKey) return;
    loadedKey.current = igKey;
    getDriveSource(client.id).then(
      (v) => {
        setView((cur) => (cur ? { ...cur, instagramAccounts: v.instagramAccounts } : cur));
        // An account that disconnected is unticked too, so Save never sends one the API refuses.
        setForm((f) => ({
          ...f,
          socialAccountIds: f.socialAccountIds.filter((id) => v.instagramAccounts.some((a) => a.id === id)),
        }));
      },
      () => {
        // The list just stays as it was; Save still checks every ticked account.
      },
    );
  }, [igKey, view, client.id]);

  /*
   * "copy" hands the link over instead of opening it here, for a phone or for
   * the account's owner: Instagram's sign-in runs in a browser and never uses
   * the Instagram app's session, so it has to open wherever that account can
   * sign in. The same link the welcome page gives clients, so it works anywhere.
   */
  const connect = async (how: "open" | "copy") => {
    setBusy(how === "open" ? "connect" : "copy");
    try {
      const res = await api.post<{ authUrl?: string }>(`/clients/${client.id}/accounts/instagram`, {});
      // The phone already is the phone: the link goes to its share sheet,
      // and only falls back to the clipboard where sharing is refused.
      const shared =
        res.authUrl && how === "copy" && isPhone && navigator.share
          ? await navigator.share({ title: `Connect Instagram to ${client.name}`, url: res.authUrl }).then(
              () => true,
              (err: unknown) => err instanceof Error && err.name === "AbortError",
            )
          : false;
      if (shared) {
        setPending(true);
      } else if (res.authUrl && how === "copy") {
        await navigator.clipboard.writeText(res.authUrl);
        setPending(true);
        toast.success("Connect link copied. Open it on the phone, or send it to the account's owner.");
      } else if (res.authUrl) {
        await openExternal(res.authUrl);
        setPending(true);
      } else {
        await refreshClients();
      }
    } catch (err) {
      toast.fail("Could not connect Instagram", err);
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    try {
      await api.post(`/clients/${client.id}/accounts/sync`, {});
      await refreshClients();
      setPending(false);
      // A sync that finds nothing new leaves the list looking untouched.
      toast.success("Accounts synced.");
    } catch (err) {
      toast.fail(`Could not sync ${client.name}'s accounts`, err);
    } finally {
      setBusy(null);
    }
  };

  // `link` is only passed by the phone's Stop, which saves with no folder link.
  const save = async (link = form.link.trim()) => {
    setBusy("save");
    try {
      apply(await saveDriveSource(client.id, { ...form, link, mode: "live", on: link !== "" }));
      toast.success(
        link
          ? `Saved. ${client.name}'s folder posts as Instagram trial reels, oldest video first, starting within ${DRIVE_CHECK_MINUTES} minutes.`
          : "Saved. With no folder link, nothing posts.",
      );
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s Drive auto-post`, err);
    } finally {
      setBusy(null);
    }
  };

  const checkFolder = async () => {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await checkDriveFolder(client.id, form.link.trim()));
    } catch (err) {
      toast.fail("Could not check the folder", err);
    } finally {
      setBusy(null);
    }
  };

  const run = view ? driveRunState(view.settings) : null;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const checkText =
    check &&
    (!check.ok
      ? check.reason
      : check.videos === 0
        ? "The folder opened. It has no .mp4 or .mov videos yet."
        : `The folder opened. ${check.videos} ${check.videos === 1 ? "video" : "videos"}: ${check.sample.join(", ")}${check.videos > check.sample.length ? ", and more" : ""}.`);

  if (isPhone) {
    // Phone (mobile pass): a status pill and line, four numbers, the long
    // explanation folded into How it works, Check folder beside the link,
    // accounts as tick chips, three big tiles, a stepper for trial reels per
    // day, Graduation in a small sheet with both choices explained, Save and
    // a Stop that asks first, and the recent videos four at a time.
    const [label, ...rest] = run ? run.text.split(". ") : [];
    const tone = !run || run.tone === "off" ? "" : run.tone === "bad" ? "bad" : label === "Starting" ? "warn" : "ok";
    const line = rest.join(". ");
    const short = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
    const added = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const checkedAt = (iso: string) => {
      const d = new Date(iso);
      const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? `today at ${t}` : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${t}`;
    };
    const videos = view ? (allVideos ? view.imports : view.imports.slice(0, 4)) : [];
    return (
      <section id="fl-drive" className="mb-card fl-card fl-drive" data-testid="drive-auto-post" aria-label="Drive auto-post">
        <div className="fl-dah">
          <span className="mb-lic fl-dlic">
            <Ic name="i-drive" />
          </span>
          <span className="mb-grow">
            <b>Drive auto-post</b>
            <small>Instagram trial reels only</small>
          </span>
          {run && <span className={`mb-pill${tone ? ` ${tone}` : ""}`}>{label}</span>}
        </div>
        {run && line && (
          <p className={`fl-runline${tone ? ` ${tone}` : ""}`} data-testid="drive-auto-post.status">
            <i aria-hidden="true" />
            {line}
          </p>
        )}
        {!view ? (
          <p className="fl-help">Loading...</p>
        ) : (
          <>
            {view.counts && (
              <div className="fl-stats">
                <div className="fl-stat">
                  <span>Today</span>
                  <b>
                    {view.counts.today} <small>of {view.settings.dailyLimit ?? DRIVE_DEFAULT_PER_DAY}</small>
                  </b>
                  <small>trial reels</small>
                </div>
                {view.counts.ahead != null && (
                  <div className="fl-stat">
                    <span>On the calendar</span>
                    <b>{view.counts.ahead}</b>
                    <small>{view.counts.next ? `next ${short(view.counts.next)}` : "none to go out"}</small>
                  </div>
                )}
                {view.settings.waiting != null && (
                  <div className="fl-stat">
                    <span>Waiting in the folder</span>
                    <b>{view.settings.waiting}</b>
                    <small>oldest goes first</small>
                  </div>
                )}
                <div className="fl-stat">
                  <span>Scheduled so far</span>
                  <b>{view.counts.posted}</b>
                  <small>as trial reels</small>
                </div>
              </div>
            )}
            <p className="fl-help fl-tight">
              {view.settings.lastCheckAt
                ? `Last checked ${checkedAt(view.settings.lastCheckAt)}.${view.settings.lastResult ? ` ${view.settings.lastResult}` : ""}`
                : "Not checked yet."}
            </p>
            <details className="fl-disc">
              <summary>
                <Ic name="i-info" />
                <span>How it works</span>
                <small>Trial reels only, oldest first</small>
                <Ic name="i-chev" />
              </summary>
              <p>
                Paste a shared Drive folder link, tick the Instagram accounts, and Save. Every video in the folder posts as an{" "}
                <b>Instagram trial reel only</b>, oldest first, a few each day, to every ticked account at the same time, with a caption written by
                AI from the video. Videos added to the folder later join the end of the line. Each one shows on the calendar in violet before it
                goes out, so you can move it or change its caption there. Nothing goes to TikTok, YouTube, Facebook or this brand's other
                accounts, and nothing posts as a regular reel.
              </p>
            </details>
            {!view.keyReady && (
              <p className="fl-warn">The server has no Google API key (GOOGLE_DRIVE_API_KEY), so it cannot read Drive folders yet.</p>
            )}
            <div className="mb-field">
              <label htmlFor="fl-drive-link">Drive folder link</label>
              <div className="mb-inrow">
                <input
                  id="fl-drive-link"
                  className="mb-input"
                  inputMode="url"
                  placeholder="https://drive.google.com/drive/folders/..."
                  value={form.link}
                  maxLength={500}
                  onChange={(e) => {
                    setForm({ ...form, link: e.target.value });
                    setCheck(null);
                  }}
                />
                <button
                  type="button"
                  className="mb-btn ghost"
                  disabled={busy !== null || (!form.link.trim() && !view.settings.folderId)}
                  onClick={() => void checkFolder()}
                >
                  {busy === "check" ? "Checking..." : "Check folder"}
                </button>
              </div>
              {check && (
                <p className={`fl-okline ${check.ok ? "ok" : "bad"}`} role="status">
                  <Ic name={check.ok ? "i-check-circle" : "i-x-circle"} />
                  {checkText}
                </p>
              )}
            </div>
            <div className="mb-field">
              <span className="mb-flab">Instagram accounts (trial reels only)</span>
              {view.instagramAccounts.length > 0 ? (
                <>
                  <div className="fl-accts">
                    {view.instagramAccounts.map((a) => {
                      const on = form.socialAccountIds.includes(a.id);
                      return (
                        <button key={a.id} type="button" role="checkbox" aria-checked={on} className={`fl-acct${on ? " on" : ""}`} onClick={() => tick(a.id, !on)}>
                          <Pf p="ig" size="sm" />@{a.handle}
                          <span className="fl-ck" aria-hidden="true">
                            <Ic name="i-check" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="fl-help">
                    Each new video posts as a trial reel to every ticked account at the same time. Only Instagram accounts are listed, because only
                    Instagram has trial reels.
                  </p>
                </>
              ) : (
                <p className="fl-warn">A connected Instagram account is needed. Connect one below.</p>
              )}
              <div className="fl-tiles three">
                <button type="button" disabled={busy !== null} onClick={() => void connect("open")}>
                  <Ic name="i-plus" />
                  {busy === "connect" ? "Opening..." : "Connect another"}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void connect("copy")}>
                  <Ic name="i-share" />
                  {busy === "copy" ? "Sharing..." : "Share connect link"}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void sync()}>
                  <Ic name="i-refresh" />
                  {busy === "sync" ? "Syncing..." : "Sync accounts"}
                </button>
              </div>
              {pending && (
                <p className="fl-warn">
                  Sign in to Instagram as the account you are adding, not one already connected. Instagram asks for that account's login in the
                  browser even if it is signed in on the Instagram app. Then tap Sync accounts, and it shows up here to tick.
                </p>
              )}
              {view.settings.socialAccountIds.some((id) => !view.instagramAccounts.some((a) => a.id === id)) && (
                <p className="fl-warn">An account ticked before is no longer connected, so it is unticked. Saving leaves it out.</p>
              )}
            </div>
            <div className="fl-grp">
              <div className="fl-optrow">
                <span className="mb-lt">
                  <b>Trial reels per day</b>
                  <small>Empty means {DRIVE_DEFAULT_PER_DAY} a day</small>
                </span>
                <Stepper
                  label="Trial reels per day"
                  value={form.dailyLimit ?? DRIVE_DEFAULT_PER_DAY}
                  min={1}
                  max={50}
                  onChange={(n) => setForm({ ...form, dailyLimit: n })}
                >
                  <input
                    className="fl-num"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={50}
                    step={1}
                    aria-label="Trial reels per day"
                    placeholder={String(DRIVE_DEFAULT_PER_DAY)}
                    value={form.dailyLimit ?? ""}
                    onChange={(e) => {
                      // Half-typed text like "1e" keeps the last good number rather than becoming no limit.
                      if (e.target.validity.badInput) return;
                      const n = e.target.valueAsNumber;
                      setForm({ ...form, dailyLimit: Number.isFinite(n) ? n : null });
                    }}
                  />
                </Stepper>
              </div>
              <button type="button" className="fl-optrow" aria-haspopup="dialog" onClick={() => setPickGrad(true)}>
                <span className="mb-lt">
                  <b>Graduation</b>
                  <small>{form.graduation === "MANUAL" ? "You decide in Instagram" : "Instagram decides when it does well"}</small>
                </span>
                <span className="fl-selv">
                  {form.graduation === "MANUAL" ? "Manual" : "Based on performance"}
                  <Ic name="i-chev" />
                </span>
              </button>
            </div>
            <p className="fl-help fl-tight">Spread between 9 AM and 9 PM. Each one lands on the calendar at least 2 hours ahead.</p>
            <button type="button" className="mb-btn pri block" disabled={busy !== null} onClick={() => void save()}>
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            {view.settings.on && (
              <button type="button" className="fl-stop" disabled={busy !== null} onClick={() => setStopping(true)}>
                <Ic name="i-pause" />
                Stop Drive auto-post
              </button>
            )}
            {view.imports.length > 0 && (
              <div className="mb-field">
                <div className="fl-rvh">
                  <span className="mb-flab">Recent videos</span>
                  <small>{view.imports.length}</small>
                </div>
                <div className="fl-rows">
                  {videos.map((i) => {
                    const pill = DRIVE_STATUS[i.status] ?? { label: i.status, tag: "due" };
                    return (
                      <div key={i.id} className="fl-rvrow">
                        <span className={`mb-pill ${PILL_TONE[pill.tag] ?? "info"}`}>{pill.label}</span>
                        <span className="mb-grow">
                          <b>{i.name}</b>
                          <small>{i.reason ?? `Added ${added(i.createdAt)}`}</small>
                        </span>
                      </div>
                    );
                  })}
                </div>
                {view.imports.length > 4 && (
                  <button type="button" className="fl-more" aria-expanded={allVideos} onClick={() => setAllVideos((v) => !v)}>
                    {allVideos ? "Show fewer" : `Show all ${view.imports.length}`}
                    <Ic name="i-chev" />
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {pickGrad && (
          <PickSheet
            label="Graduation"
            value={form.graduation}
            options={[
              { value: "MANUAL", label: "Manual", hint: "You decide in Instagram whether a trial reel goes to followers." },
              { value: "SS_PERFORMANCE", label: "Based on performance", hint: "Instagram shares it with followers when it does well." },
            ]}
            onPick={(v) => setForm((f) => ({ ...f, graduation: v as DriveSourceSave["graduation"] }))}
            onClose={() => setPickGrad(false)}
          />
        )}
        {stopping && (
          <ConfirmSheet
            title="Stop Drive auto-post?"
            body="This clears the folder link and saves, so nothing new posts. Trial reels already on the calendar stay there; remove any you do not want from the calendar."
            confirm="Stop"
            danger
            busy={busy === "save"}
            onConfirm={() => void save("").then(() => setStopping(false))}
            onClose={() => setStopping(false)}
          />
        )}
      </section>
    );
  }

  return (
    <div className="card glass" style={{ marginBottom: 16 }} data-testid="drive-auto-post">
      <h3>Drive auto-post: Instagram trial reels only</h3>
      {run && (
        <p
          data-testid="drive-auto-post.status"
          className={run.tone === "off" ? "sub" : undefined}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            margin: "0 0 8px",
            color: run.tone === "ok" ? "var(--green)" : run.tone === "bad" ? "var(--red)" : undefined,
          }}
        >
          {run.text}
        </p>
      )}
      <p className="sub" style={{ fontSize: 11.5, margin: "0 0 8px" }}>
        Paste a shared Drive folder link, tick the Instagram accounts, and Save. Every video in the folder posts as an{" "}
        <b>Instagram trial reel only</b>, oldest first, a few each day, to every ticked account at the same time, with a
        caption written by AI from the video. Videos added to the folder later join the end of the line. Each one shows
        on the calendar in violet before it goes out, so you can move it or change its caption there. Nothing goes to
        TikTok, YouTube, Facebook or this brand's other accounts, and nothing posts as a regular reel.
      </p>
      {!view ? (
        <p className="sub" style={{ fontSize: 11.5 }}>Loading...</p>
      ) : (
        <div className="pcontact">
          {!view.keyReady && (
            <p style={{ fontSize: 12, color: "var(--amber)", margin: 0 }}>
              The server has no Google API key (GOOGLE_DRIVE_API_KEY), so it cannot read Drive folders yet.
            </p>
          )}
          <label className="cfield">
            <span className="lab">Drive folder link</span>
            <input
              className="field-in"
              placeholder="https://drive.google.com/drive/folders/..."
              value={form.link}
              maxLength={500}
              onChange={(e) => {
                setForm({ ...form, link: e.target.value });
                setCheck(null);
              }}
            />
          </label>
          <div className="cfield">
            <span className="lab">Instagram accounts (trial reels only)</span>
            {view.instagramAccounts.length > 0 ? (
              <>
                {view.instagramAccounts.map((a) => (
                  <label key={a.id} style={{ fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={form.socialAccountIds.includes(a.id)}
                      onChange={(e) => tick(a.id, e.target.checked)}
                    />{" "}
                    @{a.handle}
                  </label>
                ))}
                <span className="sub" style={{ fontSize: 11 }}>
                  Each new video posts as a trial reel to every ticked account at the same time. Only Instagram accounts
                  are listed, because only Instagram has trial reels.
                </span>
              </>
            ) : (
              <span style={{ fontSize: 12, color: "var(--amber)" }}>
                A connected Instagram account is needed. Connect one below.
              </span>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11.5 }}
                title={`Connect one more Instagram account to ${client.name}, for trial reels`}
                disabled={busy !== null}
                onClick={() => void connect("open")}
              >
                {busy === "connect" ? "Opening..." : "+ Connect another Instagram account"}
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11.5 }}
                title="Copy the connect link to open on a phone, or to send to the account's owner"
                disabled={busy !== null}
                onClick={() => void connect("copy")}
              >
                {busy === "copy" ? "Copying..." : "Copy link for phone"}
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11.5 }}
                title={`Pull in accounts newly connected to ${client.name}`}
                disabled={busy !== null}
                onClick={() => void sync()}
              >
                {busy === "sync" ? "Syncing..." : "Sync accounts"}
              </button>
            </div>
            {pending && (
              <span style={{ fontSize: 11, color: "var(--amber)" }}>
                Sign in to Instagram as the account you are adding, not one already connected. Instagram asks for that
                account's login in the browser even if it is signed in on the Instagram app. Then click Sync accounts, and
                it shows up here to tick.
              </span>
            )}
            {view.settings.socialAccountIds.some((id) => !view.instagramAccounts.some((a) => a.id === id)) && (
              <span style={{ fontSize: 11, color: "var(--amber)" }}>
                An account ticked before is no longer connected, so it is unticked. Saving leaves it out.
              </span>
            )}
          </div>
          <label className="cfield">
            <span className="lab">Trial reels per day</span>
            <input
              className="field-in"
              type="number"
              min={1}
              max={50}
              step={1}
              style={{ width: 120 }}
              placeholder={String(DRIVE_DEFAULT_PER_DAY)}
              value={form.dailyLimit ?? ""}
              onChange={(e) => {
                // Half-typed text like "1e" keeps the last good number rather than becoming no limit.
                if (e.target.validity.badInput) return;
                const n = e.target.valueAsNumber;
                setForm({ ...form, dailyLimit: Number.isFinite(n) ? n : null });
              }}
            />
            <span className="sub" style={{ fontSize: 11 }}>
              How many videos from the folder go out each day, spread between 9 AM and 9 PM. Each one lands on the
              calendar at least 2 hours ahead. Empty means {DRIVE_DEFAULT_PER_DAY} a day.
            </span>
          </label>
          <label className="cfield">
            <span className="lab">Graduation</span>
            <select
              className="field-in"
              value={form.graduation}
              title="Manual: you decide in Instagram whether a trial reel goes to followers. Based on performance: Instagram shares it with followers when it does well."
              onChange={(e) => setForm({ ...form, graduation: e.target.value as DriveSourceSave["graduation"] })}
            >
              <option value="MANUAL">Manual</option>
              <option value="SS_PERFORMANCE">Based on performance</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="cbtn" disabled={busy !== null} onClick={() => void save()}>
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            <button
              className="btn ghost"
              style={{ fontSize: 11.5 }}
              disabled={busy !== null || (!form.link.trim() && !view.settings.folderId)}
              onClick={() => void checkFolder()}
            >
              {busy === "check" ? "Checking..." : "Check folder"}
            </button>
          </div>
          <span className="sub" style={{ fontSize: 11 }}>
            To stop, clear the folder link and Save. Trial reels already on the calendar stay there; remove any you do
            not want from the calendar.
          </span>
          {check && (
            <p style={{ fontSize: 11.5, margin: 0, color: check.ok ? "var(--green)" : "var(--red)" }}>{checkText}</p>
          )}
          {view.counts && (
            <span style={{ fontSize: 11.5 }}>
              <b>Today:</b> {view.counts.today} of {view.settings.dailyLimit ?? DRIVE_DEFAULT_PER_DAY} trial reels
              {view.counts.ahead != null && (
                <>
                  {" · "}
                  <b>On the calendar to go out:</b> {view.counts.ahead}
                  {view.counts.next && `, next ${when(view.counts.next)}`}
                </>
              )}
              {view.settings.waiting != null && (
                <>
                  {" · "}
                  <b>Waiting in the folder:</b> {view.settings.waiting}
                </>
              )}
              {" · "}
              <b>Scheduled as trial reels so far:</b> {view.counts.posted}
            </span>
          )}
          <span className="sub" style={{ fontSize: 11 }}>
            {view.settings.lastCheckAt
              ? `Last checked ${new Date(view.settings.lastCheckAt).toLocaleString()}.${view.settings.lastResult ? ` ${view.settings.lastResult}` : ""}`
              : "Not checked yet."}
          </span>
          {view.imports.length > 0 && (
            <div className="cfield">
              <span className="lab">Recent videos</span>
              {view.imports.map((i) => {
                const pill = DRIVE_STATUS[i.status] ?? { label: i.status, tag: "due" };
                return (
                  <div
                    key={i.id}
                    style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
                    title={new Date(i.createdAt).toLocaleString()}
                  >
                    <span className={`tag ${pill.tag}`} style={{ flex: "0 0 auto" }}>
                      {pill.label}
                    </span>
                    <div style={{ minWidth: 0, fontSize: 11.5 }}>
                      <b style={{ wordBreak: "break-all" }}>{i.name}</b>
                      {i.reason && (
                        <div className="sub" style={{ fontSize: 11 }}>
                          {i.reason}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
