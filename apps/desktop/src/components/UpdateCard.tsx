import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppUpdate } from "../lib/appUpdate";
import { api } from "../lib/api";

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

type ServerState =
  | { kind: "unknown" }
  | { kind: "not-deployed" }
  | { kind: "current"; commit: string }
  | { kind: "behind"; commit: string; head: string }
  | { kind: "unreachable"; why: string };

export default function UpdateCard() {
  const { update, phase, progress, problem, checkedAndCurrent, look, install, dismiss } =
    useAppUpdate();
  const [server, setServer] = useState<ServerState>({ kind: "unknown" });
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  const checkServer = async (): Promise<ServerState> => {
    let status: DeployStatus;
    try {
      status = await api.get<DeployStatus>("/deploy/status");
    } catch (err) {
      return { kind: "unreachable", why: err instanceof Error ? err.message : String(err) };
    }
    if (!status.available || !status.current) return { kind: "not-deployed" };

    try {
      // The repository is public, so this needs no token. Unauthenticated
      // GitHub allows 60 requests an hour, and this happens on a button press.
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
  };

  const checkEverything = async () => {
    setBusy(true);
    setServer({ kind: "unknown" });
    try {
      // Both at once: they are independent and each is a network round trip.
      const [, s] = await Promise.all([look(), checkServer()]);
      setServer(s);
    } finally {
      setBusy(false);
    }
  };

  const checking = busy || phase === "checking";
  const working = phase === "downloading" || phase === "installing" || phase === "done";

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
