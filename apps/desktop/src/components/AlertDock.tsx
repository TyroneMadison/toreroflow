import { useState } from "react";
import { api, type SystemAlert } from "../lib/api";

/**
 * Open problems, on the side of the window, wherever you are in the app.
 *
 * The sidebar already carries a count, and the Reports screen shows the list,
 * but a count is a number you learn to stop noticing and a list on one screen
 * is invisible from the other eight. Some things have to interrupt: a
 * publishing credential that stopped working, or a State filing deadline that
 * arrives once a year and costs the company real money if it passes.
 *
 * So it sits over the app rather than inside a screen, and it only appears
 * when there is something undismissed to say. Dismissing is per alert and
 * sticks until the problem recurs, which is what stops this becoming the thing
 * everybody closes without reading.
 */
export default function AlertDock({
  alerts,
  onChanged,
}: {
  alerts: SystemAlert[];
  onChanged(): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const open = alerts.filter((a) => !a.dismissed);
  if (open.length === 0) return null;

  const dismiss = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/alerts/${id}/dismiss`, {});
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  if (collapsed) {
    return (
      <button
        className={`alertdock-tab${open.some((a) => a.severity === "error") ? " bad" : ""}`}
        title="Show what needs attention"
        onClick={() => setCollapsed(false)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <use href="#i-alert" />
        </svg>
        {open.length}
      </button>
    );
  }

  return (
    <aside className="alertdock" role="status" aria-live="polite">
      <div className="alertdock-head">
        <b>Needs attention</b>
        <button className="alertdock-hide" title="Hide these for now" onClick={() => setCollapsed(true)}>
          ✕
        </button>
      </div>
      {open.map((a) => (
        <div key={a.id} className={`alertcard${a.severity === "error" ? " bad" : ""}`}>
          <div className="alertcard-msg">{a.message}</div>
          {a.detail && <div className="alertcard-detail">{a.detail}</div>}
          {a.clientName && <div className="alertcard-detail">Client: {a.clientName}</div>}
          <button
            className="btn ghost alertcard-ack"
            disabled={busy === a.id}
            onClick={() => void dismiss(a.id)}
          >
            {busy === a.id ? "…" : "Got it"}
          </button>
        </div>
      ))}
    </aside>
  );
}
