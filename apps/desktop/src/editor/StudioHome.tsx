import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../components/Toasts";
import "./StudioHome.css";

/**
 * The Studio's front door: every edit project for the selected brand.
 *
 * A row is a project; clicking it opens the editor. New project creates on
 * the server first so the editor always has a real id to autosave against.
 */

interface EditProjectRow {
  id: string;
  name: string;
  status: string;
  clipCount: number;
  durationSec: number;
  updatedAt: string;
}

/** "3m ago" style age. Coarse on purpose: the list re-sorts by recency anyway. */
function ago(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function StudioHome({
  clientId,
  onOpen,
}: {
  clientId: string;
  onOpen(projectId: string): void;
}) {
  const toast = useToast();
  const [projects, setProjects] = useState<EditProjectRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  // Two-press delete: the first click arms this row, the second deletes it.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProjects(await api.get<EditProjectRow[]>(`/clients/${clientId}/edit-projects`));
    } catch (err) {
      toast.fail("Could not load projects", err);
      setProjects([]);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const p = await api.post<{ id: string }>(`/clients/${clientId}/edit-projects`);
      onOpen(p.id);
    } catch (err) {
      toast.fail("Could not create the project", err);
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    try {
      await api.del(`/edit-projects/${id}`);
      setProjects((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
    } catch (err) {
      toast.fail("Could not delete that project", err);
    }
  };

  return (
    <div className="studiohome">
      <div className="studiohead">
        <h3>Your projects</h3>
        <div className="sub">Pick up where you left off, or start fresh.</div>
      </div>

      <button className="btn newproject" disabled={creating} onClick={() => void create()}>
        + New project
      </button>

      {projects === null ? (
        <div className="stagger">
          <div className="skel projskel" />
          <div className="skel projskel" />
          <div className="skel projskel" />
        </div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects yet. Drop footage in and the studio cuts it for you.</div>
      ) : (
        <div className="stagger">
          {projects.map((p) => (
            <div className="best projrow" key={p.id} onClick={() => onOpen(p.id)}>
              <div className="l">
                <svg className="projfilm" viewBox="0 0 24 24">
                  <use href="#i-film" />
                </svg>
                <div className="projmeta">
                  <b>{p.name}</b>
                  <div className="sub">
                    {ago(p.updatedAt)} - {p.clipCount} {p.clipCount === 1 ? "clip" : "clips"} -{" "}
                    {Math.round(p.durationSec)}s
                  </div>
                </div>
              </div>
              <button
                className="dangerbtn"
                title={
                  confirmId === p.id
                    ? "Click again to delete this project"
                    : "Delete this project"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirmId === p.id) void remove(p.id);
                  else {
                    setConfirmId(p.id);
                    setTimeout(() => setConfirmId((c) => (c === p.id ? null : c)), 3000);
                  }
                }}
              >
                {confirmId === p.id ? "Sure?" : "Delete"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
