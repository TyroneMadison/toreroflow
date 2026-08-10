import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_CLIP_FX,
  edlFromDoc,
  emptyDoc,
  locate,
  splitAt,
  type AudioItem,
  type EditDoc,
} from "@toreroflow/core";
import { api } from "../lib/api";
import { actionFor, loadOverrides, type KeyActionId, type KeyBinding } from "../lib/keymap";
import { useEditDoc, type SaveState } from "./useEditDoc";
import KeymapModal from "./KeymapModal";
import PhonePreview from "./PhonePreview";
import AutoCutStep from "./steps/AutoCutStep";
import EditStep from "./steps/EditStep";
import CaptionStep from "./steps/CaptionStep";
import ExportStep from "./steps/ExportStep";
import "./StudioEditor.css";

/* ---- API shapes ---- */

export interface EditWord {
  start: number;
  end: number;
  word: string;
}

export interface EditAssetInfo {
  id: string;
  kind: "clip" | "audio" | "graphic";
  originalName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  words: EditWord[] | null;
  status: "uploaded" | "processing" | "ready" | "failed";
  /** Signed paths for the webview; absolute via fileUrl(). */
  sourceUrl: string | null;
  proxyUrl: string | null;
  stripUrl: string | null;
}

export interface EditProjectInfo {
  id: string;
  clientId: string;
  name: string;
  status: string;
  doc: EditDoc | null;
  assets: EditAssetInfo[];
}

export type Selection =
  | null
  | { kind: "clip"; assetId: string }
  | { kind: "text" | "broll" | "graphic" | "audio"; id: string };

export interface EditorCtx {
  project: EditProjectInfo;
  assets: EditAssetInfo[];
  refreshAssets: () => Promise<void>;
  doc: EditDoc;
  update: (fn: (d: EditDoc) => EditDoc) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  outputTime: number;
  seek: (t: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  step: number;
  setStep: (n: number) => void;
  saveState: SaveState;
  /** "blade" arms click-to-split on the timeline; "select" is the mouse. */
  tool: "select" | "blade";
  setTool: (t: "select" | "blade") => void;
  /** Runs a keymap action by id, so buttons and keys share one behavior. */
  runAction: (id: KeyActionId) => void;
}

const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside StudioEditor");
  return ctx;
}

const STEPS = ["1. Auto cut", "2. Edit", "3. Caption style", "4. Export"];

/** What the database calls a project nobody has named. Matches the Prisma default. */
const UNTITLED = "Untitled project";

/**
 * The Studio editor shell. Loads one project, owns the doc state and the
 * shared playback clock, and renders the 4-step flow with the phone preview
 * docked right.
 */
export default function StudioEditor({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  // Save copy swaps this to the copy's id, which reloads and remounts below.
  const [pid, setPid] = useState(projectId);
  const [project, setProject] = useState<EditProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProject(null);
    setError(null);
    api
      .get<EditProjectInfo>(`/edit-projects/${pid}`)
      .then((p) => {
        if (live) setProject(p);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "could not load the project");
      });
    return () => {
      live = false;
    };
  }, [pid]);

  if (error) {
    return (
      <div className="stu">
        <div className="stu-top">
          <button className="iconbtn" title="Back to projects" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
        </div>
        <div className="card glass">
          <h3>That project could not be opened</h3>
          <div className="sub">{error}</div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="stu">
        <div className="card glass">
          <div className="skel" style={{ height: 18, width: 220, marginBottom: 12 }} />
          <div className="skel" style={{ height: 260 }} />
        </div>
      </div>
    );
  }

  return <LoadedEditor key={project.id} initial={project} onClose={onClose} onOpenCopy={setPid} />;
}

function LoadedEditor({
  initial,
  onClose,
  onOpenCopy,
}: {
  initial: EditProjectInfo;
  onClose: () => void;
  onOpenCopy: (id: string) => void;
}) {
  const [project, setProject] = useState(initial);
  const [assets, setAssets] = useState(initial.assets);
  const { doc, update, undo, redo, canUndo, canRedo, saveState } = useEditDoc(
    initial.id,
    initial.doc ??
      emptyDoc(initial.assets.filter((a) => a.kind === "clip").map((a) => a.id)),
  );

  const [step, setStep] = useState(1);
  const [selection, setSelection] = useState<Selection>(null);
  const [playing, setPlaying] = useState(false);
  const [outputTime, setOutputTime] = useState(0);
  const [tool, setTool] = useState<"select" | "blade">("select");
  const [keyOverrides, setKeyOverrides] = useState<Partial<Record<KeyActionId, KeyBinding>>>(
    loadOverrides,
  );
  const [showKeys, setShowKeys] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  /*
   * The project's name, typed here or nowhere.
   *
   * A new project is created as "Untitled project" and there was no way to
   * change that, so a second one was indistinguishable from the first. Held
   * locally while typing and written on blur rather than per keystroke: the
   * document autosaves on a debounce because it changes constantly, but a name
   * is finished when the operator looks away from it.
   */
  // An untouched project shows the placeholder rather than the words
  // "Untitled project", so typing a name does not start with selecting one.
  const [nameDraft, setNameDraft] = useState(
    initial.name === UNTITLED ? "" : initial.name,
  );
  const commitName = useCallback(() => {
    const typed = nameDraft.trim();
    if (typed !== nameDraft) setNameDraft(typed);
    const next = typed || UNTITLED;
    if (next === project.name) return;
    setProject((prev) => ({ ...prev, name: next }));
    void api.patch(`/edit-projects/${project.id}`, { name: next }).catch(() => {
      // Losing a rename is not worth interrupting an edit for. The next blur
      // tries again, and the name on screen is the one the operator typed.
    });
  }, [nameDraft, project.id, project.name]);

  // seek() records the target in a ref and bumps a counter; the preview
  // applies it to the video element in an effect keyed on the counter.
  const seekTo = useRef(0);
  const [seekN, setSeekN] = useState(0);
  const seek = useCallback((t: number) => {
    seekTo.current = Math.max(0, t);
    setOutputTime(seekTo.current);
    setSeekN((n) => n + 1);
  }, []);

  const refreshAssets = useCallback(async () => {
    const p = await api.get<EditProjectInfo>(`/edit-projects/${project.id}`);
    setAssets(p.assets);
    setProject((prev) => ({ ...prev, name: p.name, status: p.status }));
  }, [project.id]);

  /* ---- keyboard actions ----
     One listener for the whole editor. Every action reads the same selection
     and doc the mouse does, so a key and a click can never disagree. */

  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    return d;
  }, [assets]);

  const docRef = useRef(doc);
  docRef.current = doc;
  const stateRef = useRef({ selection, outputTime, playing, tool });
  stateRef.current = { selection, outputTime, playing, tool };

  const runAction = useCallback(
    (id: KeyActionId) => {
      const { selection: sel, outputTime: t, playing: pl, tool: tl } = stateRef.current;
      const d = docRef.current;
      const FRAME = 1 / 30;
      const edl = edlFromDoc(d, durations);
      const total = edl.reduce((acc, s) => acc + (s.srcOut - s.srcIn), 0);

      switch (id) {
        case "select":
          setTool("select");
          return;
        case "blade":
          setTool(tl === "blade" ? "select" : "blade");
          return;
        case "playPause":
          setPlaying(!pl);
          return;
        case "prevFrame":
        case "nextFrame": {
          const dir = id === "nextFrame" ? 1 : -1;
          seek(Math.max(0, Math.min(total, t + dir * FRAME)));
          return;
        }
        case "jumpStart":
          seek(0);
          return;
        case "jumpEnd":
          seek(Math.max(0, total - 0.001));
          return;
        case "undo":
          undo();
          return;
        case "redo":
          redo();
          return;
        case "splitAtPlayhead": {
          const loc = total > 0 ? locate(edl, Math.min(t, total - 0.001)) : null;
          if (!loc) return;
          const seg = edl[loc.segIndex];
          if (!seg) return;
          update((x) => splitAt(x, seg.assetId, loc.srcTime));
          return;
        }
        case "delete": {
          if (!sel) return;
          if (sel.kind === "clip") {
            update((x) => ({ ...x, clips: x.clips.filter((c) => c.assetId !== sel.assetId) }));
          } else if (sel.kind === "text") {
            update((x) => ({ ...x, texts: x.texts.filter((i) => i.id !== sel.id) }));
          } else if (sel.kind === "broll") {
            update((x) => ({ ...x, broll: x.broll.filter((i) => i.id !== sel.id) }));
          } else if (sel.kind === "graphic") {
            update((x) => ({ ...x, graphics: x.graphics.filter((i) => i.id !== sel.id) }));
          } else {
            update((x) => ({ ...x, audio: x.audio.filter((i) => i.id !== sel.id) }));
          }
          setSelection(null);
          return;
        }
        case "duplicate": {
          // Overlays only: a main clip appears once per asset by design, and
          // the timeline keys blocks by asset id.
          if (!sel || sel.kind === "clip") return;
          const nid = Math.random().toString(36).slice(2, 10);
          const copy = <T extends { id: string; at: number; dur: number }>(it: T): T => ({
            ...it,
            id: nid,
            at: it.at + it.dur,
          });
          if (sel.kind === "text") {
            update((x) => {
              const it = x.texts.find((i) => i.id === sel.id);
              return it ? { ...x, texts: [...x.texts, copy(it)] } : x;
            });
          } else if (sel.kind === "broll") {
            update((x) => {
              const it = x.broll.find((i) => i.id === sel.id);
              return it ? { ...x, broll: [...x.broll, copy(it)] } : x;
            });
          } else if (sel.kind === "graphic") {
            update((x) => {
              const it = x.graphics.find((i) => i.id === sel.id);
              return it ? { ...x, graphics: [...x.graphics, copy(it)] } : x;
            });
          } else {
            update((x) => {
              const it = x.audio.find((i) => i.id === sel.id);
              return it ? { ...x, audio: [...x.audio, copy(it)] } : x;
            });
          }
          return;
        }
        case "mute": {
          if (!sel) return;
          if (sel.kind === "clip") {
            update((x) => {
              const fx = x.clipFx[sel.assetId] ?? DEFAULT_CLIP_FX;
              return {
                ...x,
                clipFx: {
                  ...x.clipFx,
                  [sel.assetId]: { ...fx, volume: fx.volume === 0 ? 100 : 0 },
                },
              };
            });
          } else if (sel.kind === "audio") {
            update((x) => ({
              ...x,
              audio: x.audio.map((i) =>
                i.id === sel.id ? { ...i, volume: i.volume === 0 ? 100 : 0 } : i,
              ),
            }));
          } else if (sel.kind === "broll") {
            update((x) => ({
              ...x,
              broll: x.broll.map((i) =>
                i.id === sel.id ? { ...i, volume: i.volume === 0 ? 100 : 0 } : i,
              ),
            }));
          }
          return;
        }
        case "detachAudio": {
          if (!sel || sel.kind !== "clip") return;
          const assetId = sel.assetId;
          const duration = durations[assetId];
          if (!(duration > 0)) return;
          const cuts = d.cuts[assetId] ?? [];
          const interior = cuts.some((c) => c.end < duration - 0.001 || c.start > 0.001);
          // With words cut out of the middle, one continuous audio item would
          // drift out of sync with the video the moment the first cut passes.
          // Refusing is honest; the whole-clip case is the one people mean.
          if (interior && !(cuts.length === 1 && cuts[0]!.end >= duration - 0.001)) return;
          const tail = cuts.find((c) => c.end >= duration - 0.001);
          const visible = duration - (tail ? tail.end - tail.start : 0);
          let atOut = 0;
          for (const seg of edl) {
            if (seg.assetId === assetId) break;
            atOut += seg.srcOut - seg.srcIn;
          }
          const item: AudioItem = {
            id: Math.random().toString(36).slice(2, 10),
            assetId,
            at: atOut,
            dur: Math.max(0.2, visible),
            volume: d.clipFx[assetId]?.volume ?? 100,
            kind: "detached",
            srcIn: 0,
          };
          update((x) => ({
            ...x,
            audio: [...x.audio, item],
            clipFx: {
              ...x.clipFx,
              [assetId]: { ...(x.clipFx[assetId] ?? DEFAULT_CLIP_FX), volume: 0 },
            },
          }));
          setSelection({ kind: "audio", id: item.id });
          return;
        }
      }
    },
    [durations, seek, undo, redo, update],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Typing is typing. A key aimed at an input, a textarea, or an open
      // dialog must never reach the timeline.
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable ||
          t.closest('[role="dialog"]'))
      ) {
        return;
      }
      if (showKeys) return;
      const id = actionFor(e, keyOverrides);
      if (!id) return;
      e.preventDefault();
      runAction(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyOverrides, runAction, showKeys]);

  const saveCopy = useCallback(async () => {
    setCopying(true);
    setCopyError(null);
    try {
      const copy = await api.post<{ id: string }>(`/edit-projects/${project.id}/copy`);
      onOpenCopy(copy.id);
    } catch (e: unknown) {
      setCopyError(e instanceof Error ? e.message : "could not save a copy");
      setCopying(false);
    }
  }, [project.id, onOpenCopy]);

  const ctx = useMemo<EditorCtx>(
    () => ({
      project,
      assets,
      refreshAssets,
      doc,
      update,
      undo,
      redo,
      canUndo,
      canRedo,
      outputTime,
      seek,
      playing,
      setPlaying,
      selection,
      setSelection,
      step,
      setStep,
      saveState,
      tool,
      setTool,
      runAction,
    }),
    [
      project,
      assets,
      refreshAssets,
      doc,
      update,
      undo,
      redo,
      canUndo,
      canRedo,
      outputTime,
      seek,
      playing,
      selection,
      step,
      saveState,
      tool,
      runAction,
    ],
  );

  return (
    <EditorContext.Provider value={ctx}>
      <div className="stu">
        <div className="stu-top">
          <button className="iconbtn" title="Back to projects" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <input
            className="namein stu-name"
            aria-label="Project name"
            value={nameDraft}
            maxLength={120}
            placeholder="Name this project"
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setNameDraft(project.name === UNTITLED ? "" : project.name);
                e.currentTarget.blur();
              }
            }}
          />
          <div className="stu-steps">
            {STEPS.map((label, i) => {
              const n = i + 1;
              const done = n < step;
              // The live editor never reopens intake once a cut exists.
              const locked = n === 1 && step > 1;
              return (
                <span
                  key={label}
                  className={`stu-step-pill${n === step ? " on" : ""}${done ? " done" : ""}`}
                  onClick={() => {
                    if (!locked && n !== step) setStep(n);
                  }}
                >
                  {done && (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-check" />
                    </svg>
                  )}
                  {label}
                </span>
              );
            })}
          </div>
          <div className="stu-save">
            {tool === "blade" && (
              <span className="mini" style={{ color: "var(--v)", fontWeight: 700 }}>
                Blade: click a clip to split. A to leave.
              </span>
            )}
            {copyError && <span className="mini stu-copyerr">{copyError}</span>}
            <span className={`mini stu-savestate${saveState === "saved" ? " ok" : ""}`}>
              {saveState === "saving" ? "Saving..." : "Saved"}
            </span>
            <button
              className="btn ghost"
              title="Keyboard shortcuts, and where to change them"
              onClick={() => setShowKeys(true)}
            >
              Keys
            </button>
            <button className="btn ghost" onClick={saveCopy} disabled={copying}>
              {copying ? "Copying..." : "Save copy"}
            </button>
          </div>
        </div>

        <div className="stu-body">
          <div className="stu-stepbody">
            {step === 1 && <AutoCutStep />}
            {step === 2 && <EditStep />}
            {step === 3 && <CaptionStep />}
            {step === 4 && <ExportStep />}
          </div>
          {step !== 1 && (
            <PhonePreview seekN={seekN} seekTo={seekTo} onClock={setOutputTime} />
          )}
        </div>
      </div>
      {showKeys && (
        <KeymapModal
          overrides={keyOverrides}
          onChange={setKeyOverrides}
          onClose={() => setShowKeys(false)}
        />
      )}
    </EditorContext.Provider>
  );
}
