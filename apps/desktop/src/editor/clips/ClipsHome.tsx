import { useCallback, useEffect, useRef, useState } from "react";
import { ClipActivityFeed, ClipImports, ClipLibrary, ClipPerformanceTable } from "./ClipsLibrary";
import type { MediaAssetInfo } from "../../lib/api";
import { API_URL, ApiError, api, getToken, videoLabel } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { formatDuration } from "../../lib/video";
import { RUNNING, type ClipJobRow } from "./clipTypes";
import RecipesPanel, { useRecipes } from "./RecipesPanel";
import "./Clips.css";

/**
 * Studio > Clips front door (mock-ups 02 and 03): drop a long video, pick a
 * length and an optional prompt, and the worker cuts it into scored clips.
 * Running jobs are polled; the worker owns everything after the 201.
 */

const LENGTHS: { id: string; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "<30", label: "<30s" },
  { id: "30-60", label: "30-60s" },
  { id: "60-90", label: "60-90s" },
  { id: "90-180", label: "90s-3m" },
];
const ASPECTS = ["9:16", "1:1", "4:5", "16:9"];

function uploadJob(clientId: string, file: File, options: object, onProgress: (f: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // Fields before the file: the route reads them off the same part stream.
    form.append("options", JSON.stringify(options));
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/clients/${clientId}/clip-jobs`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as { id: string });
      else reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the server."));
    xhr.send(form);
  });
}

export default function ClipsHome({ clientId, onOpen }: { clientId: string; onOpen: (jobId: string) => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<ClipJobRow[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploads, setUploads] = useState<MediaAssetInfo[]>([]);
  const [fromUpload, setFromUpload] = useState("");
  const [length, setLength] = useState("auto");
  const [aspect, setAspect] = useState("9:16");
  const [prompt, setPrompt] = useState("");
  const { recipes, load: loadRecipes } = useRecipes(clientId);
  // "" = the brand default, applied when a clip opens.
  const [recipeId, setRecipeId] = useState("");
  const [showRecipes, setShowRecipes] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"jobs" | "library" | "performance" | "activity" | "imports">("jobs");

  const load = useCallback(async () => {
    try {
      setJobs(await api.get<ClipJobRow[]>(`/clients/${clientId}/clip-jobs`));
    } catch (e) {
      toast.fail("Loading clip jobs", e);
      setJobs([]);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
    api.get<MediaAssetInfo[]>(`/clients/${clientId}/media`).then(
      (m) => setUploads(m.filter((a) => a.kind === "video" && a.status === "ready")),
      () => setUploads([]),
    );
  }, [clientId, load]);

  const running = jobs?.some((j) => RUNNING.has(j.status));
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [running, load]);

  async function start() {
    const options = {
      length,
      aspect,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(recipeId ? { recipeId } : {}),
    };
    setBusy(0);
    try {
      const res = file
        ? await uploadJob(clientId, file, options, (f) => setBusy(f))
        : await api.post<{ id: string }>(`/clients/${clientId}/clip-jobs/from-asset`, { mediaAssetId: fromUpload, ...options });
      setFile(null);
      setFromUpload("");
      setPrompt("");
      onOpen(res.id);
    } catch (e) {
      toast.fail("Starting the clip job", e);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    try {
      await api.del(`/clip-jobs/${id}`);
      setJobs((js) => js?.filter((j) => j.id !== id) ?? null);
    } catch (e) {
      toast.fail("Deleting the clip job", e);
    }
  }

  const tabs = (
    <div className="pnl-pills cliptabs">
      {(["jobs", "library", "performance", "activity", "imports"] as const).map((t) => (
        <button key={t} className={`pnl-pill${view === t ? " on" : ""}`} onClick={() => setView(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
  if (view !== "jobs") {
    return (
      <div className="clipshome">
        {tabs}
        {view === "library" && <ClipLibrary clientId={clientId} onOpen={onOpen} />}
        {view === "performance" && <ClipPerformanceTable clientId={clientId} onOpen={onOpen} />}
        {view === "activity" && <ClipActivityFeed clientId={clientId} onOpen={onOpen} />}
        {view === "imports" && <ClipImports clientId={clientId} onOpen={onOpen} />}
      </div>
    );
  }

  return (
    <div className="clipshome">
      {tabs}
      <div
        className={`clipdrop${drag ? " over" : ""}${file ? " has" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) setFile(f);
        }}
        onClick={() => input.current?.click()}
      >
        <input ref={input} type="file" accept="video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div className="t">{file ? file.name : "Drop a long video to clip it"}</div>
        <div className="sub">{file ? `${Math.round(file.size / 1e6)} MB` : "Podcasts, talks, streams. Or pick something already in Uploads below."}</div>
      </div>

      <div className="clipopts">
        {!file && uploads.length > 0 && (
          <label>
            <span>From Uploads</span>
            <select value={fromUpload} onChange={(e) => setFromUpload(e.target.value)}>
              <option value="">Choose a video</option>
              {uploads.map((u) => (
                <option key={u.id} value={u.id}>
                  {videoLabel(u)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="row">
          <span>Clip length</span>
          <div className="seg">
            {LENGTHS.map((l) => (
              <span key={l.id} className={length === l.id ? "on" : ""} onClick={() => setLength(l.id)}>
                {l.label}
              </span>
            ))}
          </div>
        </div>
        <div className="row">
          <span>Aspect</span>
          <div className="seg">
            {ASPECTS.map((a) => (
              <span key={a} className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>
                {a}
              </span>
            ))}
          </div>
        </div>
        <div className="row">
          <span>Recipe</span>
          <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">{recipes.find((r) => r.isDefault) ? `Brand default (${recipes.find((r) => r.isDefault)!.name})` : "Brand default (none set)"}</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <button className="btn sm ghost" onClick={() => setShowRecipes(true)}>Recipes</button>
        </div>
        <label>
          <span>Prompt (optional)</span>
          <input value={prompt} maxLength={300} placeholder="e.g. moments about pricing" onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <button className="btn" disabled={busy !== null || (!file && !fromUpload)} onClick={() => void start()}>
          {busy !== null ? (busy > 0 ? `Uploading ${Math.round(busy * 100)}%` : "Starting") : "Get clips"}
        </button>
      </div>

      <div className="studiohead">
        <h3>Clip jobs</h3>
      </div>
      {showRecipes && (
        <RecipesPanel
          clientId={clientId}
          onClose={() => {
            setShowRecipes(false);
            void loadRecipes();
          }}
        />
      )}
      {jobs === null ? (
        <div className="stagger">
          <div className="skel projskel" />
          <div className="skel projskel" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty">No clip jobs yet. Drop a long video above and it comes back as ranked short clips.</div>
      ) : (
        <div className="stagger">
          {jobs.map((j) => (
            <div className="best projrow" key={j.id} onClick={() => onOpen(j.id)}>
              <div className="l">
                <div className="projmeta">
                  <div className="t">{j.source.name}</div>
                  <div className="sub">
                    {j.source.durationSec ? formatDuration(j.source.durationSec) : "--"} ·{" "}
                    {j.status === "ready"
                      ? `${j.clipCount ?? 0} clips · top ${j.topScore ?? "--"}`
                      : j.status === "failed"
                        ? `failed: ${j.error ?? "unknown"}`
                        : `${j.status} ${j.pct}%`}
                  </div>
                </div>
              </div>
              <button
                className="dangerbtn"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(j.id);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
