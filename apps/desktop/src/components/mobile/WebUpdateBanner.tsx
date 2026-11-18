import { useEffect, useState } from "react";
import { isTauri } from "../../lib/autostart";
import { getActivity } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";

/** The entry script this page loaded, e.g. /assets/index-AbC123.js. */
function loadedEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return el ? new URL(el.src).pathname : null;
}

/**
 * The phone's update slot (mobile pass): in a browser there is nothing to
 * install, so when the server has a newer web build than this page, say so
 * with Reload. Checks every ten minutes and when the app comes back to the
 * front. Never in the desktop app (it has its own updater) and never while a
 * request is in flight, so an upload is not interrupted.
 */
export default function WebUpdateBanner() {
  const isPhone = useIsPhone();
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    if (!isPhone || isTauri() || import.meta.env.DEV) return;
    const mine = loadedEntry();
    if (!mine) return;
    let gone = false;
    const check = async () => {
      try {
        const html = await (await fetch("/index.html", { cache: "no-store" })).text();
        const live = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
        if (!gone && live && live !== mine) setNewer(true);
      } catch {
        // Offline: the Offline pill already says so.
      }
    };
    const onVisible = () => document.visibilityState === "visible" && void check();
    const t = window.setInterval(() => void check(), 10 * 60 * 1000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isPhone]);
  if (!newer || getActivity().busy) return null;
  return (
    <div className="mb-banner info" role="status" data-testid="web-update.banner">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <use href="#i-refresh" />
      </svg>
      <span className="mb-bt">
        <b>A newer version is ready.</b> Takes a second.
      </span>
      <button type="button" className="mb-btn sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
