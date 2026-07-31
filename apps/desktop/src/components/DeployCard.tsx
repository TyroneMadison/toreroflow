import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./Toasts";
import { api } from "../lib/api";

/**
 * Ship what is on main to the server.
 *
 * The limit is worth being honest about on screen rather than only in a commit
 * message: this deploys what has been committed and pushed, not whatever is
 * open in an editor. The server pulls from the repository; it has no access to
 * anyone's working copy and should not.
 *
 * Polls rather than waits, because the deploy restarts the very API it is
 * talking to. The request that starts it returns immediately and the answer
 * arrives through a file the server writes, which survives its own restart.
 */

interface DeployState {
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  fromCommit?: string;
  toCommit?: string;
  message?: string;
}

interface DeployStatus {
  available: boolean;
  current: string | null;
  last: DeployState | null;
}

const POLL_MS = 4000;

export default function DeployCard() {
  const toast = useToast();
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const polling = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<DeployStatus>("/deploy/status"));
    } catch {
      // The API being unreachable mid-deploy is expected: it is restarting.
      // Saying so would be noise during the one minute it is true.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling while a deploy is running, and stop as soon as it is not.
  useEffect(() => {
    const running = status?.last?.status === "running";
    if (running && polling.current === null) {
      polling.current = window.setInterval(() => void load(), POLL_MS);
    } else if (!running && polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
    return () => {
      if (polling.current !== null) {
        window.clearInterval(polling.current);
        polling.current = null;
      }
    };
  }, [status?.last?.status, load]);

  const ship = async () => {
    setStarting(true);
    try {
      await api.post("/deploy", {});
      toast.success("Deploying. This card updates when it lands.");
      // Straight into the running state so the button locks immediately rather
      // than staying pressable for the four seconds until the first poll.
      setStatus((s) =>
        s ? { ...s, last: { status: "running", startedAt: new Date().toISOString() } } : s,
      );
    } catch (err) {
      toast.fail("Could not start the deploy", err);
    } finally {
      setStarting(false);
    }
  };

  if (!status) return null;

  const last = status.last;
  const running = last?.status === "running";

  return (
    <div className="card glass setsec">
      <h3>Ship an update</h3>
      <div className="sub" style={{ marginBottom: 12 }}>
        Pulls the latest committed code and rebuilds the server from it. This ships what is on
        GitHub, not unsaved changes on this machine.
      </div>

      {!status.available ? (
        <p className="insworking">
          This app is talking to an API running from a working copy rather than a server, so there
          is nothing to deploy to.
        </p>
      ) : (
        <>
          <div className="best">
            <div className="l">Server is running</div>
            <b>{status.current ? status.current.slice(0, 7) : "unknown"}</b>
          </div>

          {last && (
            <div className={`best${last.status === "failed" ? " miss" : ""}`}>
              <div className="l">
                {running
                  ? "Deploying…"
                  : last.status === "success"
                    ? "Last deploy succeeded"
                    : "Last deploy failed"}
              </div>
              <b>
                {new Date(last.finishedAt ?? last.startedAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </b>
            </div>
          )}

          {last?.message && !running && (
            <p className={last.status === "failed" ? "insfailed" : "warnline"} style={{ marginTop: 8 }}>
              {last.message}
            </p>
          )}

          <button
            className="btn"
            style={{ marginTop: 12 }}
            disabled={starting || running}
            onClick={() => void ship()}
          >
            {running ? "Deploying…" : starting ? "Starting…" : "Ship it"}
          </button>

          <p className="lnote" style={{ marginLeft: 0, marginTop: 10 }}>
            The server restarts while this runs, so the app may say it is offline for a minute.
            That is the deploy working, not failing. Updates to this app itself arrive separately,
            as a prompt in the corner.
          </p>
        </>
      )}
    </div>
  );
}
