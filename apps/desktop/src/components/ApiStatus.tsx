import { useEffect, useState } from "react";
import { API_URL } from "../lib/api";

const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Small glass pill showing whether the stack behind the app is working.
 *
 * Two separate things, because they fail apart. The API answering is what
 * makes the screens load. The worker is what transcodes an upload, publishes
 * a scheduled post and pulls analytics, and when it is not running the app
 * still accepts an upload that then never finishes. That happened, and the
 * only symptom anywhere was a card stuck on "Queued for processing", so a
 * dead worker now says so here.
 */
export default function ApiStatus() {
  const [online, setOnline] = useState(false);
  const [workerUp, setWorkerUp] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      let ok = false;
      let worker = true;
      try {
        const res = await fetch(`${API_URL}/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) {
          const data: unknown = await res.json();
          ok =
            typeof data === "object" &&
            data !== null &&
            (data as { status?: unknown }).status === "ok";
          // An older API that does not report it is not a dead worker.
          worker = (data as { worker?: unknown })?.worker !== "down";
        }
      } catch {
        ok = false;
      }
      if (!cancelled) {
        setOnline(ok);
        setWorkerUp(worker);
      }
    }

    void check();
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Amber, not red: the app works, but nothing is being processed behind it.
  const color = !online ? "var(--red)" : workerUp ? "var(--green)" : "var(--amber)";
  const label = !online ? "API offline" : workerUp ? "API online" : "Worker offline";
  return (
    <div
      className="glass-sm"
      // Always set, because on a narrow window the label is hidden and this
      // becomes the only way to read what the dot means.
      title={
        online && !workerUp
          ? "The background worker is not running, so uploads will not finish processing and scheduled posts will not go out. Start it with: pnpm --filter @toreroflow/worker dev"
          : label
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        fontSize: 11.5,
        fontWeight: 500,
        color: "var(--txt-2)",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 8px ${color}`,
          flex: "0 0 auto",
        }}
      />
      <span className="navtext">{label}</span>
    </div>
  );
}
