import { useEffect, useRef, useState } from "react";
import { readDriveSource } from "@toreroflow/core";
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

/** One pill per DriveImport status, in the tag colours the Financials rows use. */
const DRIVE_STATUS: Record<string, { label: string; tag: string }> = {
  claimed: { label: "Claimed", tag: "due" },
  downloaded: { label: "Downloaded", tag: "due" },
  dryrun: { label: "Dry run", tag: "ok" },
  scheduled: { label: "Scheduled", tag: "ok" },
  held: { label: "Held", tag: "warn" },
  skipped: { label: "Skipped", tag: "warn" },
  failed: { label: "Failed", tag: "miss" },
};

/**
 * Drive auto-post: new videos in the client's shared Drive folder post to each
 * ticked Instagram account as trial reels, captioned by AI from the video.
 *
 * Saved behind a button rather than on blur, because switching it on in Live
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
    mode: "dryrun",
    on: false,
    dailyLimit: null,
  });
  const [busy, setBusy] = useState<"save" | "check" | "connect" | "copy" | "sync" | null>(null);
  // An Instagram connect was opened in the browser and is waiting on Sync accounts.
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<DriveFolderCheck | null>(null);
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
      mode: s.mode,
      on: s.on,
      dailyLimit: s.dailyLimit,
    });
  };

  useEffect(() => {
    getDriveSource(client.id).then(apply, (err) => toast.fail(`Could not load ${client.name}'s Drive auto-post`, err));
  }, [client.id, client.name, toast]);

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
      if (res.authUrl && how === "copy") {
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

  const save = async () => {
    setBusy("save");
    try {
      apply(await saveDriveSource(client.id, { ...form, link: form.link.trim() }));
      toast.success(
        !form.on
          ? "Drive auto-post saved. It is off."
          : form.mode === "live"
            ? `Drive auto-post is live for ${client.name}. New videos post as Instagram trial reels only.`
            : `Drive auto-post is on for ${client.name} as a dry run. Nothing posts.`,
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

  return (
    <div className="card glass" style={{ marginBottom: 16 }} data-testid="drive-auto-post">
      <h3>Drive auto-post: Instagram trial reels only</h3>
      <p className="sub" style={{ fontSize: 11.5, margin: "0 0 8px" }}>
        New videos added to a shared Drive folder post as <b>Instagram trial reels only</b>, to every Instagram account
        ticked below at the same time, with a caption written by AI from the video. Nothing goes to TikTok, YouTube,
        Facebook or this brand's other accounts, and nothing posts as a regular reel. Videos already in the folder when
        you switch this on are left alone.
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
            <span className="lab">Videos per day</span>
            <input
              className="field-in"
              type="number"
              min={1}
              max={50}
              step={1}
              style={{ width: 120 }}
              placeholder="No limit"
              value={form.dailyLimit ?? ""}
              onChange={(e) => {
                // Half-typed text like "1e" keeps the last good number rather than becoming no limit.
                if (e.target.validity.badInput) return;
                const n = e.target.valueAsNumber;
                setForm({ ...form, dailyLimit: Number.isFinite(n) ? n : null });
              }}
            />
            <span className="sub" style={{ fontSize: 11 }}>
              The most new videos that post as trial reels each day. Extra videos wait in the folder and post on the next
              days. Leave empty for no limit.
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
          <div className="cfield">
            <span className="lab">Mode</span>
            <div className="modepick">
              <button className={form.mode === "dryrun" ? "on" : ""} onClick={() => setForm({ ...form, mode: "dryrun" })}>
                Dry run
              </button>
              <button className={form.mode === "live" ? "on" : ""} onClick={() => setForm({ ...form, mode: "live" })}>
                Live
              </button>
            </div>
            <span className="sub" style={{ fontSize: 11 }}>
              Dry run does everything except post. Live posts trial reels automatically.
            </span>
          </div>
          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: "flex-start", fontSize: 11.5 }}
            onClick={() => setForm({ ...form, on: !form.on })}
          >
            <span className={`switch${form.on ? " on" : ""}`} style={{ marginRight: 8 }} />
            {form.on ? "On" : "Off"}
          </button>
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
          {check && (
            <p style={{ fontSize: 11.5, margin: 0, color: check.ok ? "var(--green)" : "var(--red)" }}>
              {!check.ok
                ? check.reason
                : check.videos === 0
                  ? "The folder opened. It has no .mp4 or .mov videos yet."
                  : `The folder opened. ${check.videos} ${check.videos === 1 ? "video" : "videos"}: ${check.sample.join(", ")}${check.videos > check.sample.length ? ", and more" : ""}.`}
            </p>
          )}
          {view.counts && (
            <span style={{ fontSize: 11.5 }}>
              <b>Today:</b> {view.counts.today}
              {view.settings.dailyLimit ? ` of ${view.settings.dailyLimit}` : ""}{" "}
              {view.counts.today === 1 ? "video" : "videos"}
              {view.settings.mode === "live" ? "" : " (dry run)"}
              {view.settings.waiting != null && (
                <>
                  {" · "}
                  <b>Waiting in the folder:</b> {view.settings.waiting}
                </>
              )}
              {" · "}
              <b>Videos sent as trial reels:</b> {view.counts.posted}
              {view.counts.dryRuns > 0 && ` · Dry runs: ${view.counts.dryRuns}`}
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
