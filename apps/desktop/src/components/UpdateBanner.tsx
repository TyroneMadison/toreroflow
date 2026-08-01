import { useEffect, useState } from "react";
import { useAppUpdate } from "../lib/appUpdate";

/**
 * "There is a newer version", and the button that takes it.
 *
 * Deliberately not automatic. An app that updates itself mid-upload, or in the
 * ninety seconds before a scheduled post goes out, is an app that eats work.
 * The operator decides when.
 *
 * The check and the install live in useAppUpdate, shared with the Check for
 * updates button in Settings so the two can never disagree about what is
 * available.
 */

/** Checked on launch and then daily, which is far more often than we ship. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export default function UpdateBanner() {
  const { update, phase, progress, problem, look, install } = useAppUpdate();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void look();
    const t = setInterval(() => void look(), CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [look]);

  // A failed automatic check stays quiet: it usually means no internet, which
  // the operator already knows. Pressing the button in Settings is what asks
  // for a reason.
  if (!update || dismissed) return null;

  return (
    <div className="updatebar" role="status">
      <div className="updatebar-body">
        <b>Version {update.version} is ready</b>
        {phase === "idle" && update.body && <div className="updatebar-notes">{update.body}</div>}
        {phase === "downloading" && (
          <div className="updatebar-notes">
            Downloading{progress > 0 ? ` ${progress}%` : "…"}
          </div>
        )}
        {phase === "installing" && <div className="updatebar-notes">Installing, hold on…</div>}
        {phase === "done" && <div className="updatebar-notes">Restarting…</div>}
        {phase === "failed" && <div className="updatebar-notes bad">{problem}</div>}
      </div>
      {(phase === "idle" || phase === "failed") && (
        <>
          <button className="btn" onClick={() => void install()}>
            {phase === "failed" ? "Try again" : "Update now"}
          </button>
          <button
            className="btn ghost"
            title="It will offer again next time you open the app"
            onClick={() => setDismissed(true)}
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
