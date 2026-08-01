import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
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

/*
 * How often a running app looks for a new release.
 *
 * This was daily, on the reasoning that we ship far less often than that. The
 * reasoning was wrong: what matters is not how often a release happens but how
 * long an app that is already open takes to notice one. An app left open all
 * day found out the next morning, so the only reliable way to get an update
 * was to restart the thing, which is the opposite of what an auto-updater is
 * for.
 *
 * A check is one small request to a CDN, so a quarter of an hour costs
 * essentially nothing and turns "restart to find out" into "it tells you".
 */
const CHECK_EVERY_MS = 15 * 60 * 1000;

/**
 * Coming back to the window is the other moment worth checking, because it is
 * usually the moment somebody has been told an update exists. Throttled so
 * clicking between windows does not fire a burst of requests.
 */
const FOCUS_CHECK_FLOOR_MS = 60 * 1000;

export default function UpdateBanner() {
  const { update, phase, progress, problem, look, install } = useAppUpdate();
  const [dismissed, setDismissed] = useState(false);
  const lastLook = useRef(0);

  useEffect(() => {
    // Once one is found there is nothing left to look for: the banner is
    // already on screen and asking again cannot improve on that.
    if (update) return;

    const run = () => {
      lastLook.current = Date.now();
      void look();
    };
    run();

    const timer = setInterval(run, CHECK_EVERY_MS);
    const onFocus = () => {
      if (Date.now() - lastLook.current >= FOCUS_CHECK_FLOOR_MS) run();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [look, update]);

  /*
   * Flash the taskbar when one turns up behind the operator's back.
   *
   * The banner only says anything to somebody looking at the app, and the
   * whole point of checking every quarter hour is to catch the case where they
   * are not. This is the one signal available without adding a notifications
   * dependency, and it is the right weight anyway: an update is worth a
   * blinking icon, not a popup over whatever they are doing.
   *
   * Only when the window is not already in front, or it would flash at
   * somebody who can see the banner perfectly well.
   */
  useEffect(() => {
    if (!update) return;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        if (await win.isFocused()) return;
        if (cancelled) return;
        await win.requestUserAttention(UserAttentionType.Informational);
      } catch {
        // Not fatal and not worth reporting: the banner is still there, and a
        // window manager that refuses to flash is not a failure the operator
        // can do anything about.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [update]);

  // A failed automatic check stays quiet: it usually means no internet, which
  // the operator already knows. Pressing the button in Settings is what asks
  // for a reason.
  if (!update || dismissed) return null;

  return (
    <div className="updatebar" role="status">
      <div className="updatebar-body">
        <b>Update ready: version {update.version}</b>
        {phase === "idle" && (
          <div className="updatebar-notes">
            {/* Says what pressing it does, because it closes the app. Somebody
                mid-upload needs to know that before they press, not after. */}
            {update.body ? `${update.body} · ` : ""}
            Installs in a few seconds and restarts the app.
          </div>
        )}
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
