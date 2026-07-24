import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  api,
  fileUrl,
  uploadMedia,
  type MediaAssetInfo,
} from "../lib/api";
import { formatDuration } from "../lib/video";
import { useAppState } from "../state/AppState";

interface UploadScheduleProps {
  onPreview(name: string, url: string): void;
  onOpenConnect(): void;
}

const STATUS_LABEL: Record<MediaAssetInfo["status"], string> = {
  uploaded: "Queued for processing…",
  processing: "Transcribing, captioning, and rendering 9:16…",
  ready: "Ready",
  failed: "Processing failed",
};

export default function UploadSchedule({ onPreview, onOpenConnect }: UploadScheduleProps) {
  const { selectedClient } = useAppState();
  const [assets, setAssets] = useState<MediaAssetInfo[]>([]);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!selectedClient) {
      setAssets([]);
      return;
    }
    try {
      setAssets(await api.get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`));
    } catch {
      // API offline: keep whatever we have
    }
  }, [selectedClient]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while anything is still working its way through the pipeline.
  useEffect(() => {
    const busy = assets.some((a) => a.status === "uploaded" || a.status === "processing");
    if (!busy) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [assets, load]);

  const addFiles = async (files: FileList | File[]) => {
    if (!selectedClient) return;
    const videos = Array.from(files).filter((f) => f.type.startsWith("video/"));
    for (const file of videos) {
      setUploadingNames((prev) => [...prev, file.name]);
      try {
        await uploadMedia(selectedClient.id, file);
      } catch {
        // surfaced by the card disappearing; API error paths land in M3 polish
      } finally {
        setUploadingNames((prev) => prev.filter((n) => n !== file.name));
        void load();
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  const saveDraft = async (asset: MediaAssetInfo) => {
    const caption = drafts[asset.id];
    if (caption === undefined) return;
    await api.patch(`/media/${asset.id}/draft`, { caption });
    setSavedFlash(asset.id);
    setTimeout(() => setSavedFlash((s) => (s === asset.id ? null : s)), 2000);
    void load();
  };

  const removeAsset = async (asset: MediaAssetInfo) => {
    await api.del(`/media/${asset.id}`);
    setDrafts((d) => {
      const next = { ...d };
      delete next[asset.id];
      return next;
    });
    void load();
  };

  return (
    <section className="screen active" data-screen="upload">
      <div className="topbar">
        <div className="h">
          <h2>Upload &amp; Schedule</h2>
          <p>
            {selectedClient
              ? `Drop a video for ${selectedClient.name}. It gets transcribed, captioned, and reframed automatically.`
              : "Pick or add a brand in the sidebar, then drop a video."}
          </p>
        </div>
      </div>
      <div className="stage">
        <div className="split">
          <div>
            <div
              className="drop"
              style={dragOver ? { borderColor: "rgba(139,123,255,.65)" } : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() =>
                selectedClient ? fileInput.current?.click() : onOpenConnect()
              }
            >
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                multiple
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
              <b>Drop videos here</b>
              <p>or click to browse. MP4, MOV up to 4K. Batch drops welcome.</p>
              <div className="pills">
                <span className="mini">Auto captions</span>
                <span className="mini">Auto reframe 9:16</span>
                <span className="mini">AI post copy</span>
              </div>
            </div>

            {uploadingNames.map((name) => (
              <div className="job glass-sm" key={`up-${name}`}>
                <div className="thumb" />
                <div className="body">
                  <div className="name">{name}</div>
                  <div className="transcript">Uploading…</div>
                </div>
              </div>
            ))}

            {assets.map((asset) => {
              const thumb = fileUrl(asset.thumbUrl);
              const render = fileUrl(asset.renderUrl);
              const caption =
                drafts[asset.id] ?? asset.draftCopy?.caption ?? "";
              return (
                <div className="job glass-sm" key={asset.id}>
                  <div
                    className="thumb"
                    style={render ? { cursor: "pointer" } : undefined}
                    title={render ? "Play the captioned 9:16 render" : undefined}
                    onClick={() => {
                      if (render) onPreview(asset.name, render);
                    }}
                  >
                    {thumb && <img className="jobthumb-img" src={thumb} alt={asset.name} />}
                    {asset.durationSec != null && (
                      <span className="dur">{formatDuration(asset.durationSec)}</span>
                    )}
                    {render && (
                      <div className="play">
                        <svg>
                          <use href="#i-play" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="body">
                    <div className="name">
                      {asset.name}
                      {asset.status === "ready" && asset.hasCaptions && (
                        <span className="tag ok">Captions burned</span>
                      )}
                      {asset.status === "ready" && asset.draftCopy && (
                        <span className="tag ai">AI copy drafted</span>
                      )}
                      {asset.status === "failed" && (
                        <span className="tag" style={{ background: "rgba(255,107,122,.15)", color: "var(--red)", border: "1px solid rgba(255,107,122,.32)" }}>
                          Failed
                        </span>
                      )}
                    </div>

                    {asset.status !== "ready" ? (
                      <div className="transcript">{STATUS_LABEL[asset.status]}</div>
                    ) : (
                      <>
                        {asset.draftCopy?.hook && (
                          <div className="transcript" style={{ marginTop: 10 }}>
                            Hook: {asset.draftCopy.hook}
                          </div>
                        )}
                        <div className="captionbox" style={{ marginTop: 10 }}>
                          <textarea
                            value={caption}
                            placeholder={
                              asset.draftCopy
                                ? "Edit the AI caption…"
                                : "Write a caption. Add ANTHROPIC_API_KEY to get AI drafts."
                            }
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [asset.id]: e.target.value }))
                            }
                          />
                        </div>
                        {asset.draftCopy?.hashtags && asset.draftCopy.hashtags.length > 0 && (
                          <div className="hashrow">
                            {asset.draftCopy.hashtags.map((h) => (
                              <span className="hash" key={h}>
                                #{h.replace(/^#/, "")}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    <div className="schedrow">
                      <button className="btn ghost" onClick={() => void removeAsset(asset)}>
                        Delete
                      </button>
                      {asset.status === "ready" && (
                        <button
                          className="btn ghost"
                          onClick={() => void saveDraft(asset)}
                          disabled={drafts[asset.id] === undefined}
                        >
                          {savedFlash === asset.id ? "Saved ✓" : "Save caption"}
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ marginLeft: "auto", opacity: 0.55, cursor: "not-allowed" }}
                        title="Scheduling & publishing coming soon"
                        disabled
                      >
                        <svg>
                          <use href="#i-bolt" />
                        </svg>{" "}
                        Schedule all
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="card glass">
              <div className="rowhead">
                <h3>Up next in queue</h3>
              </div>
              <div className="empty">
                <div className="eic">
                  <svg>
                    <use href="#i-image" />
                  </svg>
                </div>
                <b>Nothing queued yet</b>
                <p>Scheduled posts will line up here once publishing goes live.</p>
              </div>
            </div>

            <div className="card glass" style={{ marginTop: 16 }}>
              <h3>
                <svg
                  style={{ width: 16, height: 16, stroke: "var(--v)", fill: "none", strokeWidth: 2 }}
                  viewBox="0 0 24 24"
                >
                  <use href="#i-bolt" />
                </svg>{" "}
                Smart timing
              </h3>
              <div className="sub" style={{ marginBottom: 8 }}>
                Best posting windows are computed from each account's own history. They appear
                once analytics ingestion starts.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
