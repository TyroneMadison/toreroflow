import { useEffect, useState } from "react";
import { API_URL } from "../lib/api";

const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Small glass pill showing connectivity to the Toreroflow API.
 * Polls GET {API_URL}/health every 15s; green when {status:"ok"}, red otherwise.
 * (Intentional addition on top of the design prototype.)
 */
export default function ApiStatus() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      let ok = false;
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
        }
      } catch {
        ok = false;
      }
      if (!cancelled) setOnline(ok);
    }

    void check();
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const color = online ? "var(--green)" : "var(--red)";
  return (
    <div
      className="glass-sm"
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
      {online ? "API online" : "API offline"}
    </div>
  );
}
