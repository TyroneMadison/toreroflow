import { useCallback, useEffect, useRef, useState } from "react";
import { ClipActivityFeed, ClipImports, ClipLibrary, ClipPerformanceTable } from "./ClipsLibrary";
import type { MediaAssetInfo } from "../../lib/api";
import { API_URL, ApiError, api, fileUrl, getToken, videoLabel } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { useToast } from "../../components/Toasts";
import { formatDuration } from "../../lib/video";
import { PhoneMenu, useLongPress, useUndoDelete } from "../phoneBits";
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
  const isPhone = useIsPhone();
  // Phone: a job's long-press menu, and delete with Undo instead of a Delete button per row.
  const [menuFor, setMenuFor] = useState<ClipJobRow | null>(null);
  const press = useLongPress<ClipJobRow>(setMenuFor);
  const undoable = useUndoDelete((id) => remove(id));

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

  const tabs = isPhone ? (
    // Phone: one segmented control that fits the width.
    <div className="seg mb-cliptabs" role="tablist" aria-label="Clips">
      {(["jobs", "library", "performance", "activity", "imports"] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={view === t} className={view === t ? "on" : ""} onClick={() => setView(t)}>
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  ) : (
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

  if (isPhone) {
    // Phone: a compact "New clip job" card (From Files or From Uploads, then
    // full-width options) and jobs as rows; Delete moves to long-press.
    const upload = uploads.find((u) => u.id === fromUpload);
    const picked = file
      ? { name: file.name, meta: `${Math.round(file.size / 1e6)} MB` }
      : upload
        ? { name: videoLabel(upload), meta: upload.durationSec ? `Long video · ${formatDuration(upload.durationSec)}` : "Long video" }
        : null;
    const def = recipes.find((r) => r.isDefault);
    const retry = async (j: ClipJobRow) => {
      try {
        await api.post(`/clip-jobs/${j.id}/retry`, { stage: j.stage === "score" ? "score" : j.stage === "curate" ? "curate" : "analyze" });
        void load();
      } catch (e) {
        toast.fail("Retrying", e);
      }
    };
    const shown = jobs?.filter((j) => !undoable.hidden.has(j.id)) ?? null;
    return (
      <div className="clipshome">
        {tabs}
        <section className="mb-hero mb-newjob" aria-label="New clip job">
          <div>
            <div className="mb-lab">New clip job</div>
            <h3>Podcasts, talks, streams</h3>
          </div>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="mb-srcpick">
            <button type="button" onClick={() => input.current?.click()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-folder" />
              </svg>
              From Files
            </button>
            <label className={uploads.length ? undefined : "dis"}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-upload" />
              </svg>
              From Uploads
              <select
                aria-label="From Uploads"
                value={fromUpload}
                disabled={!uploads.length}
                onChange={(e) => {
                  setFile(null);
                  setFromUpload(e.target.value);
                }}
              >
                <option value="">Choose a video</option>
                {uploads.map((u) => (
                  <option key={u.id} value={u.id}>
                    {videoLabel(u)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {picked && (
            <div className="mb-src">
              <span className="mb-lt">
                <b>{picked.name}</b>
                <small>{picked.meta}</small>
              </span>
              <button
                type="button"
                className="mb-ib ghost"
                aria-label="Clear the video"
                onClick={() => {
                  setFile(null);
                  setFromUpload("");
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-x" />
                </svg>
              </button>
            </div>
          )}
          <div className="mb-field">
            <span className="mb-flab">Clip length</span>
            <div className="seg">
              {LENGTHS.map((l) => (
                <button key={l.id} type="button" aria-pressed={length === l.id} className={length === l.id ? "on" : ""} onClick={() => setLength(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-field">
            <span className="mb-flab">Aspect</span>
            <div className="seg">
              {ASPECTS.map((a) => (
                <button key={a} type="button" aria-pressed={aspect === a} className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-field">
            <div className="mb-fhead">
              <label className="mb-flab" htmlFor="cj-recipe">
                Recipe
              </label>
              <button type="button" className="mb-btn text" onClick={() => setShowRecipes(true)}>
                Edit recipes
              </button>
            </div>
            <select id="cj-recipe" className="mb-input" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
              <option value="">{def ? `Brand default (${def.name})` : "Brand default (none set)"}</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mb-field">
            <label htmlFor="cj-prompt">Prompt, optional</label>
            <input id="cj-prompt" className="mb-input" value={prompt} maxLength={300} placeholder="e.g. moments about pricing" onChange={(e) => setPrompt(e.target.value)} />
          </div>
          <button type="button" className="mb-btn pri block" disabled={busy !== null || (!file && !fromUpload)} onClick={() => void start()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-scissors" />
            </svg>
            {busy !== null ? (busy > 0 ? `Uploading ${Math.round(busy * 100)}%` : "Starting") : "Get clips"}
          </button>
        </section>

        <div className="mb-sechd">
          <h2 className="mb-h2">Clip jobs</h2>
          {shown && shown.length > 0 && (
            <small>
              {shown.length} {shown.length === 1 ? "job" : "jobs"}
            </small>
          )}
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
        {shown === null ? (
          <div className="mb-jobs">
            <div className="skel mb-jobskel" />
            <div className="skel mb-jobskel" />
          </div>
        ) : shown.length === 0 ? (
          <p className="mb-p muted">No clip jobs yet. Pick a long video above and it comes back as ranked short clips.</p>
        ) : (
          <div className="mb-jobs">
            {shown.map((j) => {
              const live = RUNNING.has(j.status);
              const failed = j.status === "failed";
              const proxy = fileUrl(j.source.proxyUrl);
              const len = j.source.durationSec ? formatDuration(j.source.durationSec) : "--";
              const why = j.error ? j.error[0]!.toUpperCase() + j.error.slice(1) : "Failed, reason unknown";
              return (
                <div
                  key={j.id}
                  role="button"
                  tabIndex={0}
                  className={`mb-job${failed ? " fail" : ""}`}
                  onClick={() => onOpen(j.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpen(j.id)}
                  {...press(j)}
                >
                  <span className="mb-jthumb">{proxy && <video src={`${proxy}#t=2`} preload="metadata" muted playsInline />}</span>
                  <span className="mb-lt">
                    <b>{j.source.name}</b>
                    {failed ? (
                      <small className="mb-bad">{why}</small>
                    ) : (
                      <small>
                        {len} · {j.status === "ready" ? `${j.clipCount ?? 0} clips · ready` : j.status}
                      </small>
                    )}
                    {live && (
                      <span className="mb-prog">
                        <i style={{ transform: `scaleX(${j.pct / 100})` }} />
                      </span>
                    )}
                  </span>
                  {j.status === "ready" && j.topScore != null ? (
                    <span className={`mb-score${j.topScore < 70 ? " warn" : ""}`} aria-label={`Top score ${j.topScore}`}>
                      {j.topScore}
                    </span>
                  ) : live ? (
                    <small className="mb-pct">{j.pct}%</small>
                  ) : failed ? (
                    <button
                      type="button"
                      className="mb-btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void retry(j);
                      }}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {menuFor && (
          <PhoneMenu
            title={menuFor.source.name}
            onClose={() => setMenuFor(null)}
            items={[
              { label: "Open", run: () => onOpen(menuFor.id) },
              ...(menuFor.status === "failed" ? [{ label: "Retry", run: () => void retry(menuFor) }] : []),
              { label: "Delete clip job", danger: true, run: () => undoable.del(menuFor.id, menuFor.source.name) },
            ]}
          />
        )}
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
