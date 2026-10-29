import { useCallback, useEffect, useState } from "react";
import type { EditDoc } from "@toreroflow/core";
import { api } from "../lib/api";
import { useToast } from "../components/Toasts";
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

export default function VersionsPanel({ onClose }: { onClose: () => void }) {
  const { project, doc, update } = useEditor();
  const toast = useToast();
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ versions: VersionRow[] }>(`/edit-projects/${project.id}/versions`)).versions);
    } catch (e) {
      toast.fail("Loading versions", e);
    }
  }, [project.id, toast]);
  useEffect(() => void load(), [load]);

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
