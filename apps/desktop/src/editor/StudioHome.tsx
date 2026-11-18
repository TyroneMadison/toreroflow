import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useIsPhone } from "../lib/phone";
import { useToast } from "../components/Toasts";
import { PhoneMenu, useLongPress, useUndoDelete } from "./phoneBits";
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

/**
 * Where a project stands on the phone's four-step strip. The list only knows
 * draft, rendering, rendered or failed and the clip count, so Captions is
 * never told apart from Edit.
 */
function stageOf(p: EditProjectRow): { label: string; done: number; tone: string } {
  if (p.status === "rendered") return { label: "Done", done: 4, tone: "ok" };
  if (p.status === "rendering") return { label: "Export", done: 3, tone: "info" };
  if (p.status === "failed") return { label: "Failed", done: 3, tone: "bad" };
  return p.clipCount === 0 ? { label: "Auto cut", done: 0, tone: "nodot" } : { label: "Edit", done: 1, tone: "" };
}

/** Thumbnail colours for phone rows; the list carries no frame to show. */
const GRADS = [
  "#c2553f,#3b1d2a 60%,#121016",
  "#3d6fb8,#1d2440 60%,#0f1018",
  "#3fae84,#16302a 60%,#0f1412",
  "#8a5ad6,#2a1d40 60%,#121018",
  "#c49a4a,#3a2a18 60%,#141210",
  "#d65a8a,#3a1a2a 60%,#141012",
];

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
  // Phones: delete is a long-press option with Undo, and the list folds after five.
  const isPhone = useIsPhone();
  const [menuFor, setMenuFor] = useState<EditProjectRow | null>(null);
  const press = useLongPress<EditProjectRow>(setMenuFor);
  const undoable = useUndoDelete((id) => remove(id));
  const [all, setAll] = useState(false);

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

  if (isPhone) {
    const shown = projects?.filter((p) => !undoable.hidden.has(p.id)) ?? null;
    const older = shown && !all ? shown.length - 5 : 0;
    return (
      <div className="studiohome">
        <div className="mb-sechd">
          <h2 className="mb-h2">Your projects</h2>
          {shown && shown.length > 0 && (
            <small>
              {shown.length} {shown.length === 1 ? "project" : "projects"}
            </small>
          )}
        </div>
        <button type="button" className="mb-btn ghost block" disabled={creating} onClick={() => void create()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href="#i-plus" />
          </svg>
          New project
        </button>
        {shown === null ? (
          <div className="mb-projs">
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} className="skel mb-jobskel" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="mb-empty">
            <h3>Start your first edit</h3>
            <p>Drop footage in and the studio cuts it for you.</p>
          </div>
        ) : (
          <div className="mb-projs">
            {(older > 0 ? shown.slice(0, 5) : shown).map((p, i) => {
              const st = stageOf(p);
              return (
                <button key={p.id} type="button" className="mb-proj" onClick={() => onOpen(p.id)} {...press(p)}>
                  <span className="mb-pthumb" style={{ background: `linear-gradient(160deg,${GRADS[i % GRADS.length]})` }}>
                    {p.durationSec > 0 && <span>{Math.round(p.durationSec)}s</span>}
                  </span>
                  <span className="mb-lt">
                    <b>{p.name}</b>
                    <small>
                      {ago(p.updatedAt)} · {p.clipCount} {p.clipCount === 1 ? "clip" : "clips"}
                    </small>
                    <span className="mb-stepdots" aria-label={`${st.done} of 4 steps done`}>
                      {[0, 1, 2, 3].map((k) => (
                        <i key={k} className={k < st.done ? "on" : undefined} />
                      ))}
                    </span>
                  </span>
                  <span className={`mb-pill ${st.tone}`}>{st.label}</span>
                  <svg className="mb-chev" viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-chev-r" />
                  </svg>
                </button>
              );
            })}
          </div>
        )}
        {older > 0 && (
          <button type="button" className="mb-btn text mb-more" onClick={() => setAll(true)}>
            Show {older} older {older === 1 ? "project" : "projects"}
          </button>
        )}
        {menuFor && (
          <PhoneMenu
            title={menuFor.name}
            onClose={() => setMenuFor(null)}
            items={[
              { label: "Open", run: () => onOpen(menuFor.id) },
              { label: "Delete project", danger: true, run: () => undoable.del(menuFor.id, menuFor.name) },
            ]}
          />
        )}
      </div>
    );
  }

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
