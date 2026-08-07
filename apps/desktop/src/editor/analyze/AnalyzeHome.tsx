import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaAssetInfo } from "../../lib/api";
import { API_URL, ApiError, api, fileUrl, getToken, videoLabel } from "../../lib/api";
import Select from "../../components/Select";
import Modal from "../../modals/Modal";
import { useToast } from "../../components/Toasts";
import { formatDuration } from "../../lib/video";
import "./AnalyzeHome.css";

/**
 * Analyze's front door: every run for the selected brand.
 *
 * A run is one video read by the analyzer. Dropped files upload here; videos
 * already in Upload and Schedule are analyzed where they sit, with no second
 * copy of the file. The worker owns everything after the 201, so a running row
 * is polled rather than waited on.
 */

/** The analyzer's own cap, checked here so a 600MB file never leaves the desk. */
const MAX_BYTES = 500 * 1024 * 1024;

interface AnalysisRow {
  id: string;
  name: string;
  /** running | ready | failed. */
  status: string;
  durationSec: number | null;
  thumbUrl: string | null;
  /** The peak score, null until the run lands. */
  peak: number | null;
  error: string | null;
  requestedAt: string;
  completedAt: string | null;
}

/** A file on its way up, with the bytes it has managed so far. */
interface UploadRow {
  key: string;
  name: string;
  pct: number;
}

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "running", label: "Working" },
  { value: "failed", label: "Failed" },
];

/**
 * Multipart POST that reports how far it has got.
 *
 * `api.postForm` is fetch, and fetch cannot say how much of a request body it
 * has sent. Half a gigabyte with no feedback reads as a frozen app, so this one
 * upload path uses XHR. Everything else about it (the token, the ApiError) is
 * the shared contract.
 */
function uploadAnalysis(
  clientId: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<AnalysisRow> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/clients/${clientId}/analyses`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as AnalysisRow);
      else reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the server."));
    xhr.send(form);
  });
}

/** "620MB", for saying why a file was turned away. */
function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export default function AnalyzeHome({
  clientId,
  onOpen,
}: {
  clientId: string;
  onOpen(analysisId: string): void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<AnalysisRow[] | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assets, setAssets] = useState<MediaAssetInfo[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<AnalysisRow[]>(`/clients/${clientId}/analyses`));
    } catch (err) {
      toast.fail("Could not load the analyses", err);
      // This runs as the 4s poll as well as the first load, so blanking the
      // list would let one blip clear a full grid and read as "nothing here
      // yet". Only the first load has nothing to keep.
      setRows((cur) => cur ?? []);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the worker is actually reading something.
  const working = (rows ?? []).some((r) => r.status === "running");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [working, load]);

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("video/")) {
        toast.fail("That is not a video", new Error(`${file.name} is not an MP4, MOV or WebM.`));
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.fail(
          "That file is too big",
          new Error(`${file.name} is ${mb(file.size)}. The analyzer takes videos up to 500MB.`),
        );
        continue;
      }
      const key = `${file.name}-${Date.now()}`;
      setUploads((u) => [...u, { key, name: file.name, pct: 0 }]);
      try {
        const created = await uploadAnalysis(clientId, file, (pct) =>
          setUploads((u) => u.map((row) => (row.key === key ? { ...row, pct } : row))),
        );
        setRows((cur) => [created, ...(cur ?? [])]);
      } catch (err) {
        toast.fail("Could not start that analysis", err);
      } finally {
        setUploads((u) => u.filter((row) => row.key !== key));
      }
    }
  };

  const openPicker = async () => {
    setPickerOpen(true);
    if (assets) return;
    try {
      setAssets(await api.get<MediaAssetInfo[]>(`/clients/${clientId}/media`));
    } catch (err) {
      toast.fail("Could not load your uploads", err);
      setAssets([]);
    }
  };

  const analyzeAsset = async (assetId: string) => {
    setStarting(assetId);
    try {
      const created = await api.post<AnalysisRow>(`/clients/${clientId}/analyses/from-media`, {
        mediaAssetId: assetId,
      });
      setRows((cur) => [created, ...(cur ?? [])]);
      setPickerOpen(false);
    } catch (err) {
      toast.fail("Could not start that analysis", err);
    } finally {
      setStarting(null);
    }
  };

  const retry = async (id: string) => {
    try {
      const updated = await api.post<AnalysisRow>(`/analyses/${id}/retry`);
      setRows((cur) => (cur ? cur.map((r) => (r.id === id ? updated : r)) : cur));
    } catch (err) {
      toast.fail("Could not run that again", err);
    }
  };

  const readyCount = (rows ?? []).filter((r) => r.status === "ready").length;
  const monthCount = (rows ?? []).filter(
    (r) => r.status === "ready" && isThisMonth(r.requestedAt),
  ).length;

  // The API already orders newest first, so the toggle is a reverse rather
  // than a second sort.
  const shown = (rows ?? []).filter((r) => statusFilter === "all" || r.status === statusFilter);
  const ordered = newestFirst ? shown : [...shown].reverse();

  const pickable = (assets ?? []).filter(
    (a) => a.kind === "video" && a.status === "ready" && !a.sourceDeletedAt,
  );

  return (
    <div className="anz">
      <div className="card glass anzhero">
        <h3>Add a video to analyze</h3>
        <div className="sub">
          The analyzer reads the video itself: the words, the pace and the frames. It never
          claims platform numbers.
        </div>
        <div className="anzherorow">
          <div
            className={`drop${dragOver ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInput.current?.click()}
          >
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="ring">
              <svg>
                <use href="#i-up" />
              </svg>
            </div>
            <b>Drop a video file, or click to browse</b>
            <p>MP4, MOV or WebM up to 500MB</p>
          </div>

          <div className="glass-sm anzpickcard">
            <b>Or pick one you have already uploaded</b>
            <p>
              Analyze a video from Upload and Schedule where it sits. No second copy of the
              file.
            </p>
            <button className="cbtn" onClick={() => void openPicker()}>
              Pick an upload
            </button>
          </div>
        </div>

        {uploads.map((u) => (
          <div className="glass-sm anzup" key={u.key}>
            <div className="anzupname">{u.name}</div>
            <div className="qbar">
              <div className="fill" style={{ width: `${Math.round(u.pct * 100)}%` }} />
            </div>
            <div className="sub">Uploading {Math.round(u.pct * 100)}%</div>
          </div>
        ))}
      </div>

      <div className="kpis k2 anzstats">
        <div className="kpi glass">
          <div className="lab">Analyzed</div>
          <div className="val">{rows === null ? "-" : readyCount}</div>
        </div>
        <div className="kpi glass">
          <div className="lab">This month</div>
          <div className="val">{rows === null ? "-" : monthCount}</div>
        </div>
      </div>

      <div className="rowhead anzfilters">
        <Select
          className="anzstatus"
          value={statusFilter}
          options={STATUS_OPTIONS}
          onChange={setStatusFilter}
          aria-label="Filter by status"
        />
        <div className="seg">
          <span className={newestFirst ? "on" : ""} onClick={() => setNewestFirst(true)}>
            Newest first
          </span>
          <span className={newestFirst ? "" : "on"} onClick={() => setNewestFirst(false)}>
            Oldest first
          </span>
        </div>
      </div>

      {rows === null ? (
        <div className="anzgrid stagger">
          <div className="skel anzskel" />
          <div className="skel anzskel" />
          <div className="skel anzskel" />
          <div className="skel anzskel" />
        </div>
      ) : ordered.length === 0 ? (
        <div className="empty">
          {rows.length === 0
            ? "Nothing analyzed yet. Drop a video in and it reads the hook, the middle and the ending."
            : "Nothing matches that filter."}
        </div>
      ) : (
        <div className="anzgrid stagger">
          {ordered.map((r) => {
            const thumb = fileUrl(r.thumbUrl);
            const ready = r.status === "ready";
            return (
              <div
                className={`anzcard glass-sm${ready ? " open" : ""}`}
                key={r.id}
                onClick={() => ready && onOpen(r.id)}
                title={ready ? "Open the breakdown" : undefined}
              >
                <div className="anzshot">
                  {thumb ? (
                    <img src={thumb} alt="" />
                  ) : (
                    <svg className="anzfilm" viewBox="0 0 24 24">
                      <use href="#i-film" />
                    </svg>
                  )}
                  {r.durationSec != null && (
                    <span className="anzdur">{formatDuration(r.durationSec)}</span>
                  )}
                  {ready && r.peak != null && <span className="anzpeak">{r.peak}</span>}
                </div>
                <div className="anzmeta">
                  <b>{r.name}</b>
                  {r.status === "running" && (
                    <>
                      <div className="skel anzbar" />
                      <span className="anzstate">Reading the video...</span>
                    </>
                  )}
                  {r.status === "failed" && (
                    <>
                      <span className="chip down anzerr">
                        {r.error ?? "That run did not finish."}
                      </span>
                      <button
                        className="mini anzretry"
                        onClick={(e) => {
                          e.stopPropagation();
                          void retry(r.id);
                        }}
                      >
                        Retry
                      </button>
                    </>
                  )}
                  {ready && <span className="anzstate">Peak score {r.peak ?? "-"}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <Modal maxWidth={640} onClose={() => setPickerOpen(false)}>
          <div className="modal-head">
            <div>
              <h3>Pick an upload</h3>
              <p>Ready videos for this brand. Carousels and posted-and-cleared videos are out.</p>
            </div>
            <div className="modal-x" onClick={() => setPickerOpen(false)}>
              <svg>
                <use href="#i-x" />
              </svg>
            </div>
          </div>
          <div className="modal-body">
            {assets === null ? (
              <div className="anzpick stagger">
                <div className="skel anzskel" />
                <div className="skel anzskel" />
                <div className="skel anzskel" />
              </div>
            ) : pickable.length === 0 ? (
              <div className="empty">
                No ready videos yet. Upload one on Upload and Schedule, or drop a file here
                instead.
              </div>
            ) : (
              <div className="anzpick stagger">
                {pickable.map((a) => {
                  const thumb = fileUrl(a.thumbUrl);
                  return (
                    <div
                      className={`anzcard glass-sm open${starting === a.id ? " busy" : ""}`}
                      key={a.id}
                      onClick={() => !starting && void analyzeAsset(a.id)}
                    >
                      <div className="anzshot">
                        {thumb ? (
                          <img src={thumb} alt="" />
                        ) : (
                          <svg className="anzfilm" viewBox="0 0 24 24">
                            <use href="#i-film" />
                          </svg>
                        )}
                        {a.durationSec != null && (
                          <span className="anzdur">{formatDuration(a.durationSec)}</span>
                        )}
                      </div>
                      <div className="anzmeta">
                        <b>{videoLabel(a)}</b>
                        <span className="anzstate">
                          {starting === a.id ? "Starting..." : "Analyze this one"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
