import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppState } from "../state/AppState";

/*
 * A client's posting SOP, shown wherever a post is scheduled. When the client
 * has one, scheduling waits for the acknowledgement checkbox (and the API
 * refuses without it). With none, it says so plainly: no SOP is ever invented.
 */
export default function SopPanel({
  clientId,
  acknowledged,
  onAcknowledge,
  editable = false,
  compact = false,
}: {
  clientId: string;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  editable?: boolean;
  compact?: boolean;
}) {
  const { clients, refreshClients } = useAppState();
  const client = clients.find((c) => c.id === clientId) ?? null;
  const sop = client?.sop?.trim() ? client.sop : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sop ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A changed SOP needs reading again.
  useEffect(() => {
    setDraft(sop ?? "");
    onAcknowledge(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sop]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/clients/${clientId}/sop`, { sop: draft.trim() || null });
      await refreshClients();
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const name = client?.name ?? "This client";
  return (
    <section
      className="card glass sop-panel"
      aria-label={`${name} posting SOP`}
      data-testid="sop-panel"
      data-sop-state={sop ? "present" : "missing"}
    >
      <div className="rowhead">
        <h3>{name}'s posting SOP</h3>
        {editable && !editing && (
          <button type="button" className="btn ghost" data-testid="sop-edit" onClick={() => setEditing(true)}>
            {sop ? "Edit SOP" : "Add SOP"}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <label className="flabel" htmlFor="sop-text">
            SOP text
          </label>
          <textarea
            id="sop-text"
            className="sop-text"
            data-testid="sop-textarea"
            rows={compact ? 6 : 10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {error && <div className="autherr">{error}</div>}
          <div className="schedrow">
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn" data-testid="sop-save" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save SOP"}
            </button>
          </div>
        </>
      ) : sop ? (
        <>
          <div className="sop-body" data-testid="sop-body" style={{ whiteSpace: "pre-wrap", maxHeight: compact ? 160 : 420, overflow: "auto" }}>
            {sop}
          </div>
          <label className="sop-ack" data-testid="sop-ack-label">
            <input
              type="checkbox"
              data-testid="sop-ack"
              aria-label={`I read ${name}'s SOP`}
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
            />{" "}
            I read {name}'s SOP
          </label>
        </>
      ) : (
        <div className="empty" data-testid="sop-empty">
          <b>SOP not added yet</b>
          <p>
            Nothing to read for {name}. Scheduling is not blocked; add one{editable ? " above" : " in their Ready queue"} so
            every post follows it.
          </p>
        </div>
      )}
    </section>
  );
}

/** Whether a client's schedule action must wait for the SOP checkbox. */
export function sopRequired(sop: string | null | undefined): boolean {
  return Boolean(sop?.trim());
}
