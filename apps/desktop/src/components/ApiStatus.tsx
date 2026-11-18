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
/** The polling, shared by this pill and the dock. */
export function useApiStatus(): {
  online: boolean;
  /** False until the first answer, so nothing flashes "offline" at launch. */
  checked: boolean;
  workerUp: boolean;
  /** The API's reported version, when it says one. */
  version: string | null;
  color: string;
  label: string;
  title: string;
  /** Checks again now (the phone's Offline sheet "Try again"). */
  recheck(): void;
} {
  const [online, setOnline] = useState(false);
  const [workerUp, setWorkerUp] = useState(true);
  const [checked, setChecked] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      let ok = false;
      let worker = true;
      let ver: string | null = null;
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
          const v = (data as { version?: unknown })?.version;
          ver = typeof v === "string" ? v : null;
        }
      } catch {
        ok = false;
      }
      if (!cancelled) {
        setOnline(ok);
        setWorkerUp(worker);
        setChecked(true);
        if (ver) setVersion(ver);
      }
    }

    void check();
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tick]);

  // Amber, not red: the app works, but nothing is being processed behind it.
  const color = !online ? "var(--red)" : workerUp ? "var(--green)" : "var(--amber)";
  const label = !online ? "API offline" : workerUp ? "API online" : "Worker offline";
  const title =
    online && !workerUp
      ? "The background worker is not running, so uploads will not finish processing and scheduled posts will not go out. Start it with: pnpm --filter @toreroflow/worker dev"
      : label;
  return { online, checked, workerUp, version, color, label, title, recheck: () => setTick((t) => t + 1) };
}

export default function ApiStatus() {
  const { color, label, title } = useApiStatus();
  return (
    <div
      className="glass-sm"
      // Always set, because on a narrow window the label is hidden and this
      // becomes the only way to read what the dot means.
      title={title}
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
