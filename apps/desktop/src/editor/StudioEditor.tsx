import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { emptyDoc, type EditDoc } from "@toreroflow/core";
import { api } from "../lib/api";
import { useEditDoc, type SaveState } from "./useEditDoc";
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
}

const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside StudioEditor");
  return ctx;
}

const STEPS = ["1. Auto cut", "2. Edit", "3. Caption style", "4. Export"];

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
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

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
            {copyError && <span className="mini stu-copyerr">{copyError}</span>}
            <span className={`mini stu-savestate${saveState === "saved" ? " ok" : ""}`}>
              {saveState === "saving" ? "Saving..." : "Saved"}
            </span>
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
    </EditorContext.Provider>
  );
}
