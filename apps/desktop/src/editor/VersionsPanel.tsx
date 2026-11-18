import { useCallback, useEffect, useState } from "react";
import type { EditDoc } from "@toreroflow/core";
import { api } from "../lib/api";
import { useIsPhone } from "../lib/phone";
import { useToast } from "../components/Toasts";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import Modal from "../modals/Modal";
import { useEditor } from "./StudioEditor";

/**
 * Versions (mock-up 18): named snapshots of the edit, plus one taken
 * automatically before every export. Restore goes through update(), so it
 * is a single undo step and autosaves like any edit.
 * ponytail: no side-by-side Preview; Restore then Undo is the preview.
 */

interface VersionRow {
  id: string;
  label: string;
  auto: boolean;
  createdAt: string;
}

/** "Today, 4:08 PM", "Yesterday, 6:48 PM", "Nov 16, 2:48 PM". */
function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5);
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export default function VersionsPanel({ onClose }: { onClose: () => void }) {
  const { project, doc, update } = useEditor();
  const toast = useToast();
  const isPhone = useIsPhone();
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [label, setLabel] = useState("");
  // Phone: the newest version when it matches the edit on screen, and the Restore being asked about.
  const [nowId, setNowId] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ v: VersionRow; n: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ versions: VersionRow[] }>(`/edit-projects/${project.id}/versions`)).versions);
    } catch (e) {
      toast.fail("Loading versions", e);
    }
  }, [project.id, toast]);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    const top = rows?.[0];
    if (!isPhone || !top) return;
    let live = true;
    api.get<{ doc: EditDoc }>(`/edit-projects/${project.id}/versions/${top.id}`).then(
      (r) => live && setNowId(JSON.stringify(r.doc) === JSON.stringify(doc) ? top.id : null),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // The doc cannot change while this sheet covers the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPhone, rows, project.id]);

  async function save() {
    try {
      await api.post(`/edit-projects/${project.id}/versions`, { doc, ...(label.trim() ? { label: label.trim() } : {}) });
      setLabel("");
      await load();
    } catch (e) {
      toast.fail("Saving the version", e);
    }
  }

  async function restore(v: VersionRow) {
    try {
      const r = await api.get<{ doc: EditDoc }>(`/edit-projects/${project.id}/versions/${v.id}`);
      update(() => r.doc);
      toast.success(`Restored "${v.label}". Undo brings your edit back.`);
      onClose();
    } catch (e) {
      toast.fail("Restoring the version", e);
    }
  }

  if (isPhone) {
    // Phone sheet: label and Save side by side, one row per version, and
    // Restore asks first, keeping the current edit as a version before it goes.
    const restoreSafely = async ({ v, n }: { v: VersionRow; n: number }) => {
      setAsk(null);
      if (!nowId) {
        try {
          await api.post(`/edit-projects/${project.id}/versions`, { doc, label: `Before restoring v${n}` });
        } catch (e) {
          toast.fail("Saving your current edit", e);
          return;
        }
      }
      await restore(v);
    };
    return (
      <>
        <Modal maxWidth={480} onClose={onClose} label="Versions">
          <div className="modal-head">
            <h3>Versions</h3>
            <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
              <svg>
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          <div className="modal-body mb-vers">
            <div className="mb-inrow">
              <input
                className="mb-input"
                aria-label="Version label"
                placeholder="Label, e.g. Before client notes"
                value={label}
                maxLength={120}
                enterKeyHint="done"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
              <button type="button" className="mb-btn pri" onClick={() => void save()}>
                Save version
              </button>
            </div>
            {rows && rows.length > 0 && (
              <div className="mb-card mb-verlist">
                {rows.map((v, i) => {
                  const n = rows.length - i;
                  const now = v.id === nowId;
                  return (
                    <div key={v.id} className={`mb-ver${now ? " cur" : ""}`}>
                      <span className="mb-vn">v{n}</span>
                      <span className="mb-lt">
                        <b>
                          {v.label}
                          {v.auto ? " (auto)" : ""}
                        </b>
                        <small>
                          {when(v.createdAt)}
                          {now ? " · current" : ""}
                        </small>
                      </span>
                      {now ? (
                        <span className="mb-pill acc nodot">Now</span>
                      ) : (
                        <button type="button" className="mb-btn sm ghost" onClick={() => setAsk({ v, n })}>
                          Restore
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {rows && rows.length === 0 && <p className="mb-p muted">No versions yet. One is saved before every export.</p>}
            <p className="mb-note">The oldest version is removed after 50.</p>
          </div>
        </Modal>
        {ask && (
          <ConfirmSheet
            title={`Restore v${ask.n}?`}
            body={nowId ? "Your current edit is already saved as a version." : "Your current edit is saved as a version first."}
            confirm="Restore"
            onClose={() => setAsk(null)}
            onConfirm={() => void restoreSafely(ask)}
          />
        )}
      </>
    );
  }

  return (
    <Modal maxWidth={480} onClose={onClose} label="Versions">
      <div className="vers">
        <h3>Versions</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="field-in" style={{ flex: 1 }} placeholder="Label, e.g. Before client notes" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn" onClick={() => void save()}>+ Save version</button>
        </div>
        <div className="vers-list">
          {rows?.map((v, i) => (
            <div key={v.id} className="vers-item">
              <span className="mini">v{rows.length - i}</span>
              <b>{v.label}{v.auto ? " (auto)" : ""}</b>
              <span className="mini">{new Date(v.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <button className="btn sm ghost" onClick={() => void restore(v)}>Restore</button>
            </div>
          ))}
          {rows && rows.length === 0 && <div className="sub">No versions yet. One is saved before every export.</div>}
        </div>
        <div className="mini">Oldest removed after 50.</div>
      </div>
    </Modal>
  );
}
