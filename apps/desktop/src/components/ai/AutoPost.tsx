import { useCallback, useEffect, useRef, useState } from "react";
import { DRIVE_CHECK_MINUTES, DRIVE_DEFAULT_PER_DAY, driveRunState, readDriveSource } from "@toreroflow/core";
import Pf from "../Pf";
import { useToast } from "../Toasts";
import { api, checkDriveFolder, getDriveSource, saveDriveSource, type ClientSummary, type DriveFolderCheck, type DriveSourceSave, type DriveSourceView, type WorkflowInfo } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { useIsPhone } from "../../lib/phone";
import { usePageHead } from "../../lib/pageHead";
import { PF_ID, PLATFORMS, SURFACE_LABEL, type Platform } from "../../lib/platforms";
import { driveBand, needsLook, VIDEO_PILL } from "../../lib/aiMetrics";
import { useAppState } from "../../state/AppState";
import { Stepper } from "../mobile/FlowBits";
import { Dialog, I, Switch } from "../automations/parts";
import "./areas.css";

/**
 * Workflows > Auto-post (F5): round 2 mockup 06, desktop and phone. Drive
 * auto-post (new videos in the client's shared Drive folder post as Instagram
 * trial reels) as one status band, the recent videos as the main list, the
 * settings as a read-only summary with Edit, and the saved fan-out rules as
 * compact rows under the honest "Saved, not running yet" note: nothing runs
 * them (there is no fan-out runner). Everything the old Drive card and the
 * rules form did is still here, in the sheets. Viewers read only.
 */

const join = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

function whenText(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const y = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const nextText = (iso: string, phone: boolean) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", ...(phone ? {} : { minute: "2-digit" }) }).replace(",", "");

export default function AutoPost({ client }: { client: ClientSummary }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const { refreshClients, user } = useAppState();
  const viewer = user?.role === "viewer";

  // ---- Drive auto-post (the old DriveAutoPost card's state and actions) ----
  const [view, setView] = useState<DriveSourceView | null>(null);
  const [form, setForm] = useState<DriveSourceSave>({ link: "", socialAccountIds: [], graduation: "MANUAL", mode: "live", on: false, dailyLimit: null });
  const [busy, setBusy] = useState<"save" | "check" | "connect" | "copy" | "sync" | null>(null);
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<DriveFolderCheck | null>(null);
  const [sheet, setSheet] = useState<"settings" | "actions" | "rules" | "stop" | "rule" | null>(null);
  const [needs, setNeeds] = useState(false);
  const [allVideos, setAllVideos] = useState(false);

  const apply = (v: DriveSourceView) => {
    // A server from before several accounts could be ticked sends one id, not a list.
    const s = readDriveSource(v.settings);
    const ids = v.instagramAccounts.map((a) => a.id);
    setView({ ...v, settings: s });
    setForm({
      link: s.link,
      // An account that has since disconnected reads as unticked, so a save never sends one the API refuses.
      socialAccountIds: !s.socialAccountIds.length && ids.length === 1 ? [ids[0]!] : s.socialAccountIds.filter((id) => ids.includes(id)),
      graduation: s.graduation,
      mode: "live",
      on: s.on,
      dailyLimit: s.dailyLimit,
    });
  };
  useEffect(() => {
    getDriveSource(client.id).then(apply, (err) => toast.fail(`Could not load ${client.name}'s Drive auto-post`, err));
  }, [client.id, client.name, toast]);
  // The status, counts and recent videos stay current; the form and the account list are left alone.
  useEffect(() => {
    const t = setInterval(
      () =>
        getDriveSource(client.id).then(
          (v) => setView((cur) => cur && { ...v, settings: readDriveSource(v.settings), instagramAccounts: cur.instagramAccounts }),
          () => undefined,
        ),
      30_000,
    );
    return () => clearInterval(t);
  }, [client.id]);
  // A newly connected Instagram account (after Sync accounts) shows up to tick without a reload.
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
        setForm((f) => ({ ...f, socialAccountIds: f.socialAccountIds.filter((id) => v.instagramAccounts.some((a) => a.id === id)) }));
      },
      () => undefined,
    );
  }, [igKey, view, client.id]);

  const tick = (id: string, on: boolean) =>
    setForm((f) => ({ ...f, socialAccountIds: on ? [...f.socialAccountIds.filter((x) => x !== id), id] : f.socialAccountIds.filter((x) => x !== id) }));

  /*
   * "copy" hands the link over instead of opening it here: Instagram's sign-in
   * runs in a browser and never uses the Instagram app's session, so it has to
   * open wherever that account can sign in.
   */
  const connect = async (how: "open" | "copy") => {
    setBusy(how === "open" ? "connect" : "copy");
    try {
      const res = await api.post<{ authUrl?: string }>(`/clients/${client.id}/accounts/instagram`, {});
      const shared =
        res.authUrl && how === "copy" && isPhone && navigator.share
          ? await navigator.share({ title: `Connect Instagram to ${client.name}`, url: res.authUrl }).then(
              () => true,
              (err: unknown) => err instanceof Error && err.name === "AbortError",
            )
          : false;
      if (shared) setPending(true);
      else if (res.authUrl && how === "copy") {
        await navigator.clipboard.writeText(res.authUrl);
        setPending(true);
        toast.success("Connect link copied. Open it on the phone, or send it to the account's owner.");
      } else if (res.authUrl) {
        await openExternal(res.authUrl);
        setPending(true);
      } else await refreshClients();
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
      toast.success("Accounts synced.");
    } catch (err) {
      toast.fail(`Could not sync ${client.name}'s accounts`, err);
    } finally {
      setBusy(null);
    }
  };
  // `link` is only passed by Stop, which saves with no folder link.
  const save = async (link = form.link.trim()): Promise<boolean> => {
    setBusy("save");
    try {
      apply(await saveDriveSource(client.id, { ...form, link, mode: "live", on: link !== "" }));
      toast.success(
        link
          ? `Saved. ${client.name}'s folder posts as Instagram trial reels, oldest video first, starting within ${DRIVE_CHECK_MINUTES} minutes.`
          : "Saved. With no folder link, nothing posts.",
      );
      return true;
    } catch (err) {
      toast.fail(`Could not save ${client.name}'s Drive auto-post`, err);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const checkFolder = async (link = form.link.trim()) => {
    setBusy("check");
    setCheck(null);
    try {
      setCheck(await checkDriveFolder(client.id, link));
    } catch (err) {
      toast.fail("Could not check the folder", err);
    } finally {
      setBusy(null);
    }
  };
  const checkText =
    check &&
    (!check.ok
      ? check.reason
      : check.videos === 0
        ? "The folder opened. It has no .mp4 or .mov videos yet."
        : `The folder opened. ${check.videos} ${check.videos === 1 ? "video" : "videos"}: ${check.sample.join(", ")}${check.videos > check.sample.length ? ", and more" : ""}.`);

  // ---- Fan-out rules (saved, not running: there is no runner) ----
  const [rules, setRules] = useState<WorkflowInfo[] | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  const [rName, setRName] = useState("");
  const [source, setSource] = useState<Platform>("tiktok" as Platform);
  const [dests, setDests] = useState<Platform[]>([]);
  const loadRules = useCallback(async () => {
    try {
      setRules(await api.get<WorkflowInfo[]>(`/clients/${client.id}/workflows`));
      setRulesErr(null);
    } catch (e) {
      setRulesErr(e instanceof Error ? e.message : "could not load the rules");
    }
  }, [client.id]);
  useEffect(() => {
    setRules(null);
    void loadRules();
  }, [loadRules]);
  const createRule = async (): Promise<boolean> => {
    if (!rName.trim() || !dests.length) return false;
    try {
      await api.post(`/clients/${client.id}/workflows`, { name: rName.trim(), sourcePlatform: source, destinations: dests });
      setRName("");
      setDests([]);
      await loadRules();
      toast.success("Rule saved. It does not move videos yet.");
      return true;
    } catch (e) {
      toast.fail("Could not save the rule", e);
      return false;
    }
  };
  const toggleRule = async (w: WorkflowInfo) => {
    try {
      await api.patch(`/workflows/${w.id}`, { enabled: !w.enabled });
      await loadRules();
    } catch (e) {
      toast.fail(`Could not ${w.enabled ? "pause" : "enable"} ${w.name}`, e);
    }
  };
  const removeRule = async (w: WorkflowInfo) => {
    try {
      await api.del(`/workflows/${w.id}`);
      await loadRules();
      toast.success(`${w.name} deleted.`);
    } catch (e) {
      toast.fail(`Could not delete ${w.name}`, e);
    }
  };

  const run = view ? driveRunState(view.settings) : null;
  const band = driveBand(run);
  const perDay = view?.settings.dailyLimit ?? DRIVE_DEFAULT_PER_DAY;
  const handles = (view?.instagramAccounts ?? []).filter((a) => view?.settings.socialAccountIds.includes(a.id)).map((a) => `@${a.handle}`);
  const imports = view?.imports ?? [];
  const needCount = imports.filter((i) => needsLook(i.status)).length;
  const videos = (needs ? imports.filter((i) => needsLook(i.status)) : imports).slice(0, allVideos ? undefined : isPhone ? 4 : 6);
  const shownAll = (needs ? needCount : imports.length) <= (isPhone ? 4 : 6) || allVideos;
  const folderLink = view?.settings.link || "";

  usePageHead(
    !isPhone
      ? {
          controls: (
            <>
              <button type="button" className="au-hbtn" disabled={!folderLink} onClick={() => void openExternal(folderLink)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-folder" />
                </svg>
                Open Drive folder
              </button>
              {!viewer && (
                <button type="button" className="au-hbtn pri" disabled={busy !== null || !view?.settings.folderId} onClick={() => void checkFolder(view?.settings.link ?? "")} data-testid="autopost.check">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-refresh" />
                  </svg>
                  {busy === "check" ? "Checking..." : "Check folder now"}
                </button>
              )}
            </>
          ),
        }
      : null,
  );

  const wrap = isPhone ? "ibx-wrap ph au wa" : "ibx-wrap au wa";
  const pill = band.pill && <span className={`au-pill${band.pill.cls ? ` ${band.pill.cls}` : ""}`}>{band.pill.label}</span>;
  const checkLine = check && (
    <p className={`wa-okline ${check.ok ? "ok" : "bad"}`} role="status">
      <I name={check.ok ? "i-check-circle" : "i-x-circle"} />
      {checkText}
    </p>
  );
  const notices = (
    <>
      {view && !view.keyReady && (
        <div className={isPhone ? "au-slim warn" : "au-notice warn"}>
          <I name="i-alert" />
          <span className="grow">The server has no Google API key (GOOGLE_DRIVE_API_KEY), so it cannot read Drive folders yet.</span>
        </div>
      )}
      {pending && (
        <div className={isPhone ? "au-slim warn" : "au-notice warn"}>
          <I name="i-info" />
          <span className="grow">
            Sign in to Instagram as the account you are adding, not one already connected. Then {isPhone ? "tap" : "click"} Sync accounts, and it shows up in Settings to tick.
          </span>
        </div>
      )}
      {!isPhone && checkLine}
    </>
  );

  const actionItems = (
    <>
      <div className="au-am">
        <button type="button" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void connect("open"))}>
          <I name="i-plus" />
          <span className="grow">{busy === "connect" ? "Opening..." : "Connect another Instagram account"}</span>
        </button>
        <button type="button" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void connect("copy"))}>
          <I name="i-link" />
          <span className="grow">
            {isPhone ? "Share connect link" : "Copy connect link"}
            <small>Send it to the client to connect</small>
          </span>
        </button>
        <button type="button" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void sync())}>
          <I name="i-refresh" />
          <span className="grow">{busy === "sync" ? "Syncing..." : "Sync accounts"}</span>
        </button>
      </div>
      {view?.settings.on && !viewer && (
        <div className="au-am">
          <button type="button" className="bad" onClick={() => setSheet("stop")}>
            <I name="i-pause" />
            <span className="grow">
              Stop Drive auto-post<small>Scheduled videos stay scheduled</small>
            </span>
          </button>
        </div>
      )}
    </>
  );

  const settingsBody = view && (
    <div className="au-sheetform">
      <div className={isPhone ? "mb-field" : "au-field"}>
        <label htmlFor="ap-link" className={isPhone ? undefined : "flab"}>
          Drive folder link
        </label>
        <input
          id="ap-link"
          className={isPhone ? "mb-input mono" : "au-input mono"}
          inputMode="url"
          placeholder="https://drive.google.com/drive/folders/..."
          value={form.link}
          maxLength={500}
          disabled={viewer}
          onChange={(e) => (setForm({ ...form, link: e.target.value }), setCheck(null))}
        />
        <button type="button" className={isPhone ? "mb-btn sm ghost" : "ibx-btn ghost"} style={{ alignSelf: "flex-start" }} disabled={busy !== null || (!form.link.trim() && !view.settings.folderId)} onClick={() => void checkFolder()}>
          <I name="i-check-circle" />
          {busy === "check" ? "Checking..." : "Check folder"}
        </button>
        {checkLine}
      </div>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <span className={isPhone ? "mb-flab" : "flab"}>Post trial reels to</span>
        {view.instagramAccounts.length ? (
          <div className={isPhone ? "mb-card list au-optlist" : "wa-accticks"}>
            {view.instagramAccounts.map((a) => {
              const on = form.socialAccountIds.includes(a.id);
              return (
                <button key={a.id} type="button" role="checkbox" aria-checked={on} className="au-check au-opt" disabled={viewer} onClick={() => tick(a.id, !on)}>
                  <span className="box">{on && <I name="i-check" />}</span>
                  <Pf p="ig" size="sm" />
                  <span className="lt">
                    <b>@{a.handle}</b>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="wa-warn">A connected Instagram account is needed. Use Connect another Instagram account.</p>
        )}
        {view.settings.socialAccountIds.some((id) => !view.instagramAccounts.some((a) => a.id === id)) && (
          <p className="wa-warn">An account ticked before is no longer connected, so it is unticked. Saving leaves it out.</p>
        )}
        <span className="au-help">Each new video posts as a trial reel to every ticked account at the same time. Only Instagram has trial reels.</span>
      </div>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <span className={isPhone ? "mb-flab" : "flab"}>Trial reels a day</span>
        <div className="au-rowsb">
          <span className="au-help">Spread between 9 AM and 9 PM, at least 2 hours apart</span>
          <Stepper label="Trial reels a day" value={form.dailyLimit ?? DRIVE_DEFAULT_PER_DAY} min={1} max={50} onChange={(n) => !viewer && setForm({ ...form, dailyLimit: n })}>
            <input
              className="fl-num"
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              step={1}
              aria-label="Trial reels a day"
              disabled={viewer}
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
      </div>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <span className={isPhone ? "mb-flab" : "flab"}>Graduation</span>
        <div className={`ibx-seg full${isPhone ? " ph" : ""}`} role="radiogroup" aria-label="Graduation">
          {(
            [
              ["MANUAL", "Manual"],
              ["SS_PERFORMANCE", isPhone ? "By performance" : "Based on performance"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={form.graduation === v} className={form.graduation === v ? "on" : undefined} disabled={viewer} onClick={() => setForm({ ...form, graduation: v })}>
              {l}
            </button>
          ))}
        </div>
        <span className="au-help">{form.graduation === "MANUAL" ? "You decide in Instagram whether a trial reel goes to followers." : "Instagram shares a trial reel with followers once it does well."}</span>
      </div>
      <p className="au-help">
        Every video in the folder posts as an Instagram trial reel only, oldest first, with a caption written by AI from the video. Each one shows on the calendar before it goes out, so you can move it or change its caption there.
      </p>
    </div>
  );
  const settingsDialog = sheet === "settings" && (
    <Dialog
      phone={isPhone}
      title="Drive auto-post"
      sub={isPhone ? undefined : `Settings for ${client.name}`}
      onClose={() => setSheet(null)}
      foot={
        viewer ? (
          <button type="button" className="mb-btn block" onClick={() => setSheet(null)}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className={isPhone ? "mb-btn ghost" : "au-hbtn"} onClick={() => setSheet(null)}>
              Cancel
            </button>
            <button type="button" className={isPhone ? "mb-btn pri" : "au-hbtn pri"} disabled={busy !== null} onClick={() => void save().then((ok) => ok && setSheet(null))} data-testid="autopost.save">
              {busy === "save" ? "Saving..." : "Save"}
            </button>
          </>
        )
      }
      testId="autopost.settings"
    >
      {settingsBody}
    </Dialog>
  );
  const stopDialog = sheet === "stop" && (
    <Dialog
      phone={isPhone}
      title="Stop Drive auto-post?"
      sub="This clears the folder link and saves, so nothing new posts. Trial reels already on the calendar stay there; remove any you do not want from the calendar."
      onClose={() => setSheet(null)}
      foot={
        <>
          <button type="button" className={isPhone ? "mb-btn" : "au-hbtn"} onClick={() => setSheet(null)}>
            Cancel
          </button>
          <button type="button" className={isPhone ? "mb-btn danger" : "au-hbtn pri"} disabled={busy === "save"} onClick={() => void save("").then(() => setSheet(null))}>
            Stop
          </button>
        </>
      }
    >
      <p className="au-help">Scheduled videos stay scheduled.</p>
    </Dialog>
  );

  const flow = (w: WorkflowInfo) => (
    <span className="wa-flow fl-flow">
      <Pf p={PF_ID[w.sourcePlatform]} size="xs" />
      <I name="i-arrow-r" />
      {w.destinations.map((d) => (
        <Pf key={d} p={PF_ID[d]} size="xs" />
      ))}
      {!w.enabled && <small>Paused</small>}
    </span>
  );
  const ruleForm = (
    <>
      <span className={isPhone ? "au-new lbl" : "lbl"} style={isPhone ? undefined : { fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600 }}>
        New rule
      </span>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <label htmlFor="ap-rname" className={isPhone ? undefined : "flab"}>
          Rule name
        </label>
        <input id="ap-rname" className={isPhone ? "mb-input" : "au-input"} placeholder="For example, Reels to Shorts" value={rName} maxLength={80} onChange={(e) => setRName(e.target.value)} />
      </div>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <span className={isPhone ? "mb-flab" : "flab"}>When a video posts to</span>
        <div className={isPhone ? "au-wchips" : "ibx-chips"} role="radiogroup" aria-label="Source platform">
          {PLATFORMS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={source === p} className={`ibx-chip${source === p ? " on" : ""}`} onClick={() => (setSource(p), setDests((d) => d.filter((x) => x !== p)))}>
              {SURFACE_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <div className={isPhone ? "mb-field" : "au-field"}>
        <span className={isPhone ? "mb-flab" : "flab"}>Also post it to</span>
        <div className={isPhone ? "au-wchips" : "ibx-chips"}>
          {PLATFORMS.filter((p) => p !== source).map((p) => {
            const on = dests.includes(p);
            return (
              <button key={p} type="button" aria-pressed={on} className={`ibx-chip${on ? " on" : ""}`} data-testid={`workflow-dest-${p}`} onClick={() => setDests((d) => (on ? d.filter((x) => x !== p) : [...d, p]))}>
                {SURFACE_LABEL[p]}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
  const ruleRows = (rules ?? []).map((w) => (
    <div key={w.id} className={isPhone ? "au-optrow" : "wa-rrow"} data-testid={`workflow-${w.id}`}>
      <span className={isPhone ? "lt" : "t"}>
        <b>{w.name}</b>
        {flow(w)}
      </span>
      <Switch on={w.enabled} label={`${w.name} enabled`} disabled={viewer} onChange={() => void toggleRule(w)} />
      {!viewer && (
        <button type="button" className="ibx-btn icon ghost" aria-label={`Delete workflow ${w.name}`} data-testid={`workflow-delete-${w.id}`} onClick={() => void removeRule(w)}>
          <I name="i-trash" />
        </button>
      )}
    </div>
  ));
  const rulesDialog = (sheet === "rules" || sheet === "rule") && (
    <Dialog
      phone={isPhone}
      title="Fan-out rules"
      sub="Saved, not running yet"
      onClose={() => setSheet(null)}
      foot={
        <>
          <button type="button" className={isPhone ? "mb-btn ghost" : "au-hbtn"} onClick={() => setSheet(null)}>
            Close
          </button>
          {!viewer && (
            <button type="button" className={isPhone ? "mb-btn pri" : "au-hbtn pri"} data-testid="workflow-create" disabled={!rName.trim() || !dests.length} onClick={() => void createRule()}>
              Save rule
            </button>
          )}
        </>
      }
      testId="autopost.rules"
    >
      <div className="au-sheetform">
        <div className="ibx-banner info">
          <I name="i-info" />
          <div className="bt">Nothing moves videos by these rules today. A scheduled video only goes where you tick it.</div>
        </div>
        {sheet === "rules" && (rules?.length ? <div className={isPhone ? "mb-card list au-optlist" : "au-optlist"}>{ruleRows}</div> : <p className="au-help">No rules saved yet.</p>)}
        {!viewer && ruleForm}
      </div>
    </Dialog>
  );

  // ---------------------------------------------------------------------------
  // Phone (mockup 06-auto-post-phone)
  // ---------------------------------------------------------------------------
  if (isPhone) {
    return (
      <div className={wrap} data-testid="auto-post" data-state={view ? "ready" : "loading"}>
        <section className="wa-status" data-testid="drive-auto-post" aria-label="Drive auto-post">
          <div className="top">
            <span className="bi drive">
              <I name="i-drive" />
            </span>
            <span className="bt">
              <b>
                Drive auto-post {pill}
              </b>
              <small data-testid="drive-auto-post.status">{band.line}</small>
            </span>
          </div>
          {view?.counts && (
            <div className="wa-st4">
              <div className="stat">
                <div className="k">Today</div>
                <div className="v">
                  {view.counts.today} <small>of {perDay}</small>
                </div>
                <div className="au-prog">
                  <i style={{ width: `${Math.min(100, Math.round((view.counts.today / perDay) * 100))}%` }} />
                </div>
              </div>
              <div className="stat">
                <div className="k">Next post</div>
                <div className="v">{view.counts.next ? nextText(view.counts.next, true) : "None"}</div>
              </div>
              <div className="stat">
                <div className="k">Waiting in folder</div>
                <div className="v">{view.settings.waiting ?? "n/a"}</div>
              </div>
              <div className="stat">
                <div className="k">Scheduled so far</div>
                <div className="v">{view.counts.posted}</div>
              </div>
            </div>
          )}
          <div className="wa-btnrow">
            {!viewer && (
              <button type="button" className="mb-btn pri sm" disabled={busy !== null || !view?.settings.folderId} onClick={() => void checkFolder(view?.settings.link ?? "")} data-testid="autopost.check">
                <I name="i-refresh" />
                {busy === "check" ? "Checking..." : "Check now"}
              </button>
            )}
            <button type="button" className="mb-btn sm ghost wa-more" aria-label="More: stop, copy connect link, sync accounts" onClick={() => setSheet("actions")} data-testid="autopost.more">
              <I name="i-dots-h" />
            </button>
          </div>
          {checkLine}
        </section>
        {notices}

        <div className="au-sech">
          <h2>Recent videos</h2>
          {needCount > 0 && (
            <button type="button" className={`ibx-chip wa-needs${needs ? " on" : ""}`} aria-pressed={needs} onClick={() => setNeeds((v) => !v)}>
              Needs a look <span className="ct">{needCount}</span>
            </button>
          )}
        </div>
        <section className="mb-card list wa-vlist" aria-label="Recent videos">
          {!view ? (
            <p className="ibx-nomatch">Loading...</p>
          ) : !videos.length ? (
            <p className="ibx-nomatch">{needs ? "Nothing needs a look." : "No videos yet. They show here once the folder is checked."}</p>
          ) : (
            videos.map((v, i) => {
              const p = VIDEO_PILL[v.status] ?? { cls: "", label: v.status };
              return (
                <div key={v.id} className="wa-vr">
                  <span className={`wa-thumb g${(i % 6) + 1}`} />
                  <span className="t">
                    <b>{v.name}</b>
                    <small>{v.reason ?? `Added ${whenText(v.createdAt)}`}</small>
                  </span>
                  <span className={`au-pill${p.cls ? ` ${p.cls}` : ""}`}>{p.short ?? p.label}</span>
                </div>
              );
            })
          )}
          {!shownAll && (
            <button type="button" className="au-showmore" onClick={() => setAllVideos(true)}>
              Show all {needs ? needCount : imports.length}
              <I name="i-chev" />
            </button>
          )}
        </section>

        <div className="au-sech">
          <h2>Settings</h2>
        </div>
        <section className="mb-card list wa-set">
          <button type="button" className="au-linkrow" style={{ borderTop: 0 }} onClick={() => setSheet("settings")} data-testid="autopost.edit">
            <span className="k">Drive folder</span>
            <span className="v wa-ellip">{folderLink ? folderLink.replace(/^https?:\/\/(drive\.google\.com\/drive\/)?/, "") : "Not set"}</span>
            <I name="i-chev-r" className="chev" />
          </button>
          <button type="button" className="au-linkrow" onClick={() => setSheet("settings")}>
            <span className="k">Posts to</span>
            <span className="v">
              {handles.length ? (
                <>
                  {handles.map((h) => (
                    <Pf key={h} p="ig" size="xs" />
                  ))}
                  {handles.length === 1 ? handles[0] : `${handles.length} accounts`}
                </>
              ) : (
                "No account ticked"
              )}
            </span>
            <I name="i-chev-r" className="chev" />
          </button>
          <button type="button" className="au-linkrow" onClick={() => setSheet("settings")}>
            <span className="k">Reels a day</span>
            <span className="v">{perDay} trial reels</span>
            <I name="i-chev-r" className="chev" />
          </button>
          <button type="button" className="au-linkrow" onClick={() => setSheet("settings")}>
            <span className="k">Graduation</span>
            <span className="v">{view?.settings.graduation === "SS_PERFORMANCE" ? "By performance" : "Manual"}</span>
            <I name="i-chev-r" className="chev" />
          </button>
        </section>

        <section className="mb-card list">
          <button type="button" className="mb-lrow au-basicrow" onClick={() => setSheet("rules")} data-testid="workflow-new">
            <span className="au-lic">
              <I name="i-shuffle" />
            </span>
            <span className="mb-lt">
              <b>Fan-out rules</b>
              <small className="wa-wrap2">{rules === null ? (rulesErr ?? "Loading...") : `${rules.length} saved. Not running yet: nothing moves videos by them today.`}</small>
            </span>
            <I name="i-chev-r" />
          </button>
        </section>

        {sheet === "actions" && (
          <Dialog phone title="Drive auto-post" sub={`${band.pill?.label ?? "Off"} for ${client.name}`} onClose={() => setSheet(null)} foot={<button type="button" className="mb-btn block" onClick={() => setSheet(null)}>Cancel</button>} testId="autopost.actions">
            {actionItems}
          </Dialog>
        )}
        {settingsDialog}
        {stopDialog}
        {rulesDialog}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Desktop and web (mockup 06-auto-post-desktop)
  // ---------------------------------------------------------------------------
  return (
    <div className={wrap} data-testid="auto-post" data-state={view ? "ready" : "loading"}>
      <section className="wa-band" data-testid="drive-auto-post">
        <span className="bi drive">
          <I name="i-drive" />
        </span>
        <div className="bt">
          <b>
            {band.title} {pill}
          </b>
          <small data-testid="drive-auto-post.status">
            {band.line}
            {view?.settings.lastCheckAt && view.settings.lastResult ? ` ${view.settings.lastResult}` : ""}
          </small>
        </div>
        {view?.counts && (
          <div className="facts">
            <div className="fact">
              <div className="k">Today</div>
              <div className="v">
                {view.counts.today} <small>of {perDay}</small>
              </div>
              <div className="au-prog">
                <i style={{ width: `${Math.min(100, Math.round((view.counts.today / perDay) * 100))}%` }} />
              </div>
            </div>
            <div className="fact">
              <div className="k">Next post</div>
              <div className="v">{view.counts.next ? nextText(view.counts.next, false) : "None"}</div>
            </div>
            <div className="fact">
              <div className="k">Waiting in folder</div>
              <div className="v">
                {view.settings.waiting ?? "n/a"} <small>oldest first</small>
              </div>
            </div>
            <div className="fact">
              <div className="k">Scheduled so far</div>
              <div className="v">
                {view.counts.posted} <small>trial reels</small>
              </div>
            </div>
          </div>
        )}
        <span style={{ position: "relative" }}>
          <button type="button" className="ibx-btn icon ghost" aria-label="More: stop Drive auto-post, copy connect link, sync accounts" aria-expanded={sheet === "actions"} onClick={() => setSheet(sheet === "actions" ? null : "actions")} data-testid="autopost.more">
            <I name="i-dots-h" />
          </button>
          {sheet === "actions" && (
            <div className="au-pop" style={{ right: 0, top: 40, width: 300 }} role="menu" onMouseLeave={() => setSheet(null)}>
              <button type="button" className="pi" role="menuitem" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void connect("open"))}>
                <I name="i-plus" />
                Connect another Instagram account
              </button>
              <button type="button" className="pi" role="menuitem" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void connect("copy"))}>
                <I name="i-link" />
                Copy connect link
              </button>
              <button type="button" className="pi" role="menuitem" disabled={busy !== null || viewer} onClick={() => (setSheet(null), void sync())}>
                <I name="i-refresh" />
                Sync accounts
              </button>
              {view?.settings.on && !viewer && (
                <>
                  <span className="sepl" />
                  <button type="button" className="pi bad" role="menuitem" onClick={() => setSheet("stop")}>
                    <I name="i-pause" />
                    Stop Drive auto-post
                  </button>
                </>
              )}
            </div>
          )}
        </span>
      </section>
      {notices}

      <div className="wa-pgrid">
        <section className="au-card p0" aria-label="Recent videos">
          <div className="wa-vhead">
            <div className="sect-t">
              <h3>Recent videos</h3>
              <small>last {imports.length}</small>
            </div>
            <div className="ibx-seg" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={!needs} className={!needs ? "on" : undefined} onClick={() => setNeeds(false)}>
                All
              </button>
              <button type="button" role="tab" aria-selected={needs} className={needs ? "on" : undefined} onClick={() => setNeeds(true)}>
                Needs a look {needCount}
              </button>
            </div>
          </div>
          {!view ? (
            <p className="wa-qempty">Loading...</p>
          ) : !videos.length ? (
            <p className="wa-qempty">{needs ? "Nothing needs a look." : "No videos yet. They show here once the folder is checked."}</p>
          ) : (
            videos.map((v, i) => {
              const p = VIDEO_PILL[v.status] ?? { cls: "", label: v.status };
              return (
                <div key={v.id} className="wa-vrow" title={new Date(v.createdAt).toLocaleString()}>
                  <span className={`wa-thumb g${(i % 6) + 1}`} />
                  <span className="t">
                    <b>
                      <span>{v.name}</span> <span className={`au-pill${p.cls ? ` ${p.cls}` : ""}`}>{p.label}</span>
                    </b>
                    <small>{v.reason ?? (v.status === "scheduled" ? `On the calendar for ${join(handles) || "the ticked accounts"} as a trial reel` : p.label)}</small>
                  </span>
                  <span className="w">{whenText(v.createdAt)}</span>
                </div>
              );
            })
          )}
          {!shownAll && (
            <div className="wa-vfoot">
              <button type="button" className="ibx-btn ghost" onClick={() => setAllVideos(true)}>
                Show all {needs ? needCount : imports.length}
                <I name="i-chev" />
              </button>
            </div>
          )}
        </section>

        <aside className="wa-side">
          <section className="au-card">
            <div className="au-rowsb" style={{ marginBottom: 4 }}>
              <div className="sect-t">
                <h3>Settings</h3>
              </div>
              <button type="button" className="ibx-btn ghost" onClick={() => setSheet("settings")} disabled={!view} data-testid="autopost.edit">
                <I name="i-pencil" />
                {viewer ? "View" : "Edit"}
              </button>
            </div>
            <div className="wa-kvs">
              <div className="wa-kvr">
                <span className="k">Drive folder</span>
                <span className="v">
                  <span className="mono" title={folderLink}>
                    {folderLink ? folderLink.replace(/^https?:\/\//, "") : "Not set"}
                  </span>
                </span>
              </div>
              <div className="wa-kvr">
                <span className="k">Posts to</span>
                <span className="v">{handles.length ? join(handles) : "No account ticked"}</span>
              </div>
              <div className="wa-kvr">
                <span className="k">Trial reels a day</span>
                <span className="v">
                  <span>
                    <b>{perDay}</b> <span className="t3">between 9 AM and 9 PM</span>
                  </span>
                </span>
              </div>
              <div className="wa-kvr">
                <span className="k">Graduation</span>
                <span className="v">
                  <b>{view?.settings.graduation === "SS_PERFORMANCE" ? "Based on performance" : "Manual"}</b>
                </span>
              </div>
            </div>
          </section>
          <section className="au-card">
            <div className="au-rowsb">
              <div className="sect-t">
                <h3>Fan-out rules</h3>
                <small>{rules ? `${rules.length} saved` : ""}</small>
              </div>
              {!viewer && (
                <button type="button" className="ibx-btn ghost" onClick={() => setSheet("rule")} data-testid="workflow-new">
                  <I name="i-plus" />
                  New rule
                </button>
              )}
            </div>
            <div className="wa-saved">
              <I name="i-info" />
              <span>
                <b>Saved, not running yet.</b> Nothing moves videos by these rules today.
              </span>
            </div>
            {rules === null ? <p className="au-help">{rulesErr ?? "Loading..."}</p> : rules.length ? ruleRows : <p className="au-help">No rules saved yet.</p>}
          </section>
        </aside>
      </div>
      {settingsDialog}
      {stopDialog}
      {rulesDialog}
    </div>
  );
}
