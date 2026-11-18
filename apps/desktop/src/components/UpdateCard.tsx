import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { version as webVersion } from "../../package.json";
import { useAppUpdate } from "../lib/appUpdate";
import { api } from "../lib/api";
import { isTauri } from "../lib/autostart";
import { useIsPhone } from "../lib/phone";
import { navigate } from "../lib/routes";
import { useToast } from "./Toasts";
import { Ic } from "./analytics/phoneBits";

/**
 * Check for updates, on demand.
 *
 * The app checks itself once a day and shows a banner, which is enough when a
 * release lands while you are sitting there and useless when you have just
 * been told one exists. This asks both questions at once, on a press:
 *
 *   - Is there a newer build of this app? That is GitHub Releases, the same
 *     signed manifest the banner reads.
 *   - Is the server running older code than what is on main? That is GitHub's
 *     main branch against the commit the API reports for itself.
 *
 * Finding an app update asks before taking it, because installing restarts
 * the app and the operator may be in the middle of something.
 */

const REPO = "TyroneMadison/toreroflow";

interface DeployStatus {
  available: boolean;
  current: string | null;
}

export type ServerState =
  | { kind: "unknown" }
  | { kind: "not-deployed" }
  | { kind: "current"; commit: string }
  | { kind: "behind"; commit: string; head: string }
  | { kind: "unreachable"; why: string };

async function checkServer(): Promise<ServerState> {
  let status: DeployStatus;
  try {
    status = await api.get<DeployStatus>("/deploy/status");
  } catch (err) {
    return { kind: "unreachable", why: err instanceof Error ? err.message : String(err) };
  }
  if (!status.available || !status.current) return { kind: "not-deployed" };

  try {
    // The repository is public, so this needs no token. Unauthenticated
    // GitHub allows 60 requests an hour, and this happens on a button press
    // (and on the phone as Settings opens, once a minute at most).
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { kind: "unreachable", why: `GitHub answered ${res.status}` };
    const head = String(((await res.json()) as { sha?: string }).sha ?? "");
    if (!head) return { kind: "unreachable", why: "GitHub returned no commit" };
    return head.startsWith(status.current) || status.current.startsWith(head)
      ? { kind: "current", commit: status.current }
      : { kind: "behind", commit: status.current, head };
  } catch (err) {
    return { kind: "unreachable", why: err instanceof Error ? err.message : String(err) };
  }
}

/*
 * The last server check, shared by the phone's Settings home, Updates and Ship
 * an update, so moving between them asks GitHub once a minute at most (it
 * allows 60 unauthenticated requests an hour). Pressing Check for updates
 * always asks again.
 */
let lastCheck: { state: ServerState; at: number } | null = null;
export async function serverCheck(fresh = false): Promise<{ state: ServerState; at: number }> {
  if (!fresh && lastCheck && Date.now() - lastCheck.at < 60_000) return lastCheck;
  lastCheck = { state: await checkServer(), at: Date.now() };
  return lastCheck;
}

/** True when the server has a newer web build than this page: the question the phone's Reload banner asks. */
async function newerWebBuild(): Promise<boolean> {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  if (!mine || isTauri()) return false;
  try {
    const html = await (await fetch("/index.html", { cache: "no-store" })).text();
    const live = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
    return !!live && live !== new URL(mine.src).pathname;
  } catch {
    return false;
  }
}

/** "today, 9:38 AM", or "Nov 17, 9:38 AM" on another day. */
function checkedWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `today, ${time}`
    : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export default function UpdateCard() {
  const { update, phase, progress, problem, checkedAndCurrent, look, install, dismiss } =
    useAppUpdate();
  const [server, setServer] = useState<ServerState>({ kind: "unknown" });
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const toast = useToast();
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [newer, setNewer] = useState(false);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  // The phone page leads with the answer, so it asks as it opens.
  useEffect(() => {
    if (!isPhone) return;
    void serverCheck().then((r) => {
      setServer(r.state);
      setCheckedAt(r.at);
    });
    void newerWebBuild().then(setNewer);
  }, [isPhone]);

  const checkEverything = async () => {
    setBusy(true);
    setServer({ kind: "unknown" });
    try {
      // Both at once: they are independent and each is a network round trip.
      const [, s] = await Promise.all([look(), serverCheck(true)]);
      setServer(s.state);
      setCheckedAt(s.at);
      return s.state;
    } finally {
      setBusy(false);
    }
  };

  const checking = busy || phase === "checking";
  const working = phase === "downloading" || phase === "installing" || phase === "done";

  if (isPhone) {
    const desk = isTauri();
    const short = (c: string) => c.slice(0, 7);
    const checkNow = async () => {
      const [s, n] = await Promise.all([checkEverything(), newerWebBuild()]);
      setNewer(n);
      toast.info(
        s.kind === "behind" ? "The server is behind main."
        : s.kind === "current" ? "The server is up to date."
        : s.kind === "not-deployed" ? "The API runs from a working copy, so there is no server version to compare."
        : "Could not check the server.",
      );
    };
    return (
      <>
        <p className="st-intro">
          Looks for a newer version of this app, and checks whether the server is running the latest code.
        </p>
        {server.kind === "behind" && (
          <div className="mb-banner warn st-ban" role="status" data-testid="settings.updates.answer">
            <Ic name="i-alert" />
            <span className="mb-bt">
              <b>Server is behind main</b>
              The server runs <span className="st-mono">{short(server.commit)}</span>; GitHub main is at{" "}
              <span className="st-mono">{short(server.head)}</span>. Ship an update brings it level.
            </span>
          </div>
        )}
        {server.kind === "current" && (
          <div className="mb-banner st-ban ok" role="status" data-testid="settings.updates.answer">
            <Ic name="i-check-circle" />
            <span className="mb-bt">
              <b>Server is up to date</b>
              It runs <span className="st-mono">{short(server.commit)}</span>, the same as GitHub main.
            </span>
          </div>
        )}
        {server.kind === "not-deployed" && (
          <div className="mb-banner info st-ban" role="status" data-testid="settings.updates.answer">
            <Ic name="i-info" />
            <span className="mb-bt">
              This app is talking to an API running from a working copy, so there is no server version to compare.
            </span>
          </div>
        )}
        {server.kind === "unreachable" && (
          <div className="mb-banner st-ban" role="status" data-testid="settings.updates.answer">
            <Ic name="i-alert" />
            <span className="mb-bt">
              <b>Could not check the server</b>
              {server.why}
            </span>
          </div>
        )}

        <section className="mb-card st-vcard">
          <div className="st-vrow">
            <span className="mb-lic n">
              <Ic name={desk ? "i-desktop" : "i-phone"} />
            </span>
            <span className="mb-lt">
              <b>{desk ? "This app" : "This app on the phone"}</b>
              <small>
                {desk ? `Version ${version ?? "unknown"}` : newer ? "A newer version is ready" : `Web version ${webVersion} · up to date`}
              </small>
            </span>
            {desk ? (
              update ? <span className="mb-pill warn">Update</span> : checkedAndCurrent ? <span className="mb-pill ok">Current</span> : null
            ) : newer ? (
              <button type="button" className="mb-btn sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            ) : (
              <span className="mb-pill ok">Current</span>
            )}
          </div>
          <div className="st-vrow">
            <span className="mb-lic n">
              <Ic name="i-globe" />
            </span>
            <span className="mb-lt">
              <b>Server</b>
              <small className={server.kind === "behind" || server.kind === "current" ? "st-mono" : undefined}>
                {server.kind === "behind"
                  ? `${short(server.commit)} · main is at ${short(server.head)}`
                  : server.kind === "current"
                    ? `${short(server.commit)} · same as main`
                    : server.kind === "not-deployed"
                      ? "Runs from a working copy"
                      : server.kind === "unreachable"
                        ? "Could not check"
                        : "Checking"}
              </small>
            </span>
            {server.kind === "behind" && <span className="mb-pill warn">Behind</span>}
            {server.kind === "current" && <span className="mb-pill ok">Up to date</span>}
            {server.kind === "unreachable" && (
              <button type="button" className="mb-btn sm text" disabled={checking} onClick={() => void checkNow()}>
                Try again
              </button>
            )}
          </div>
          {!desk && (
            <div className="st-vrow dim">
              <span className="mb-lic n">
                <Ic name="i-desktop" />
              </span>
              <span className="mb-lt">
                <b>Desktop app install</b>
                <small>Installs and restarts the Windows app</small>
              </span>
              <span className="mb-pill nodot">
                <Ic name="i-desktop" />
                Desktop app only
              </span>
            </div>
          )}
        </section>

        {/* A narrow window of the desktop app still installs its own updates. */}
        {desk && update && !working && (
          <div className="mb-card st-blk">
            <b>Version {update.version} is available. Update now?</b>
            {update.body && <p className="st-help">{update.body}</p>}
            <div className="mb-btnrow">
              <button type="button" className="mb-btn pri" onClick={() => void install()}>
                Yes, update
              </button>
              <button type="button" className="mb-btn ghost" onClick={dismiss}>
                No, not now
              </button>
            </div>
          </div>
        )}
        {desk && working && (
          <p className="st-help" role="status">
            {phase === "downloading"
              ? `Downloading${progress > 0 ? ` ${progress}%` : ""}`
              : phase === "installing"
                ? "Installing, hold on"
                : "Restarting"}
          </p>
        )}
        {desk && phase === "failed" && <p className="mb-err">{problem}</p>}
        {desk && !update && !checkedAndCurrent && problem && phase !== "failed" && !checking && (
          <p className="mb-err">Could not check for an app update: {problem}</p>
        )}
        {!desk && (
          <p className="st-help">On the phone a new web version shows a "Reload" banner by itself; there is nothing to install.</p>
        )}

        <div className="mb-btnrow st-upbtns">
          <button
            type="button"
            className="mb-btn"
            disabled={checking || working}
            onClick={() => void checkNow()}
            data-testid="settings.updates.check"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className={checking ? "st-spin" : undefined}>
              <use href="#i-refresh" />
            </svg>
            {checking ? "Checking" : "Check for updates"}
          </button>
          {server.kind === "behind" && (
            <button type="button" className="mb-btn pri" onClick={() => navigate("settings", "deploy")}>
              Ship an update
            </button>
          )}
        </div>
        {checkedAt && <p className="st-center">Last checked {checkedWhen(checkedAt)}</p>}
      </>
    );
  }

  return (
    <div className="card glass setsec">
      <h3>Check for updates</h3>
      <div className="sub" style={{ marginBottom: 12 }}>
        Looks for a newer version of this app, and checks whether the server is running the
        latest code.
      </div>

      <div className="best">
        <div className="l">This app</div>
        <b>{version ? `v${version}` : "…"}</b>
      </div>

      {server.kind === "current" && (
        <div className="best">
          <div className="l">Server is up to date</div>
          <b>{server.commit.slice(0, 7)}</b>
        </div>
      )}
      {server.kind === "behind" && (
        <div className="best miss">
          <div className="l">Server is behind main</div>
          <b>
            {server.commit.slice(0, 7)} → {server.head.slice(0, 7)}
          </b>
        </div>
      )}
      {server.kind === "unreachable" && (
        <p className="warnline" style={{ marginTop: 8 }}>
          Could not check the server: {server.why}
        </p>
      )}
      {server.kind === "not-deployed" && (
        <p className="lnote" style={{ marginLeft: 0, marginTop: 8 }}>
          This app is talking to an API running from a working copy, so there is no server
          version to compare.
        </p>
      )}

      {/* The question, only once something was actually found. */}
      {update && !working && (
        <div className="updateask">
          <b>Version {update.version} is available. Update now?</b>
          {update.body && <div className="sub">{update.body}</div>}
          <div className="askrow">
            <button className="btn" onClick={() => void install()}>
              Yes, update
            </button>
            <button
              className="btn ghost"
              title="Nothing changes. It will offer again next time you check or restart."
              onClick={dismiss}
            >
              No, not now
            </button>
          </div>
        </div>
      )}

      {working && (
        <p className="insworking" style={{ marginTop: 10 }}>
          {phase === "downloading"
            ? `Downloading${progress > 0 ? ` ${progress}%` : "…"}`
            : phase === "installing"
              ? "Installing, hold on…"
              : "Restarting…"}
        </p>
      )}

      {phase === "failed" && (
        <p className="insfailed" style={{ marginTop: 10 }}>
          {problem}
        </p>
      )}

      {!update && checkedAndCurrent && !checking && (
        <p className="insworking" style={{ marginTop: 10 }}>
          This is the newest version.
        </p>
      )}

      {/* A check the operator pressed deserves a reason when it fails, unlike
          the silent daily one. */}
      {!update && !checkedAndCurrent && problem && phase !== "failed" && !checking && (
        <p className="warnline" style={{ marginTop: 10 }}>
          Could not check for an app update: {problem}
        </p>
      )}

      <button
        className="btn"
        style={{ marginTop: 12 }}
        disabled={checking || working}
        onClick={() => void checkEverything()}
      >
        {checking ? "Checking…" : "Check for updates"}
      </button>
    </div>
  );
}
