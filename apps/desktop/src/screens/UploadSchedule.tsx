import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  api,
  fileUrl,
  uploadMedia,
  type ClientPost,
  type MediaAssetInfo,
  type PostTargetInfo,
} from "../lib/api";
import { formatDuration } from "../lib/video";
import { useAppState } from "../state/AppState";
import Pf from "../components/Pf";
import { PF_ID } from "../lib/platforms";
import ScheduleModal from "../modals/ScheduleModal";
import PostDetailModal from "../modals/PostDetailModal";
import BestTimes from "../components/BestTimes";
import QuotaCard from "../components/QuotaCard";

const fmtWhen = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

interface UploadScheduleProps {
  onPreview(name: string, url: string): void;
  onOpenConnect(): void;
}

const STATUS_LABEL: Record<MediaAssetInfo["status"], string> = {
  uploaded: "Queued for processing…",
  processing: "Transcribing and drafting copy…",
  ready: "Ready",
  failed: "Processing failed",
};

export default function UploadSchedule({ onPreview, onOpenConnect }: UploadScheduleProps) {
  const { selectedClient } = useAppState();
  const [assets, setAssets] = useState<MediaAssetInfo[]>([]);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [posts, setPosts] = useState<PostTargetInfo[]>([]);
  const [scheduling, setScheduling] = useState<MediaAssetInfo | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [overTargetId, setOverTargetId] = useState<string | null>(null);
  const [queueDetail, setQueueDetail] = useState<PostTargetInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [bestTimePosts, setBestTimePosts] = useState<ClientPost[]>([]);
  const [quotaKey, setQuotaKey] = useState(0);
  const [revBusy, setRevBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const connectedCount = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected",
  ).length;

  const loadPosts = useCallback(async () => {
    if (!selectedClient) {
      setPosts([]);
      return;
    }
    try {
      setPosts(await api.get<PostTargetInfo[]>(`/clients/${selectedClient.id}/posts`));
    } catch {
      // API offline: keep whatever we have
    }
  }, [selectedClient]);

  useEffect(() => {
    void loadPosts();
    const t = setInterval(() => void loadPosts(), 15_000);
    return () => clearInterval(t);
  }, [loadPosts]);

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

  // Published history drives the best-times panel; it is cached server-side.
  useEffect(() => {
    if (!selectedClient) {
      setBestTimePosts([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ posts: ClientPost[] }>(`/clients/${selectedClient.id}/analytics/posts`)
      .then((d) => {
        if (!cancelled) setBestTimePosts(d.posts);
      })
      .catch(() => {
        if (!cancelled) setBestTimePosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient]);

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
    const description = drafts[asset.id];
    const title = titles[asset.id];
    if (description === undefined && title === undefined) return;
    await api.patch(`/media/${asset.id}/draft`, {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    setSavedFlash(asset.id);
    setTimeout(() => setSavedFlash((s) => (s === asset.id ? null : s)), 2000);
    void load();
  };

  /**
   * Reordering the queue means trading slots: the two posts swap scheduled
   * times, which also moves each delayed publish job.
   */
  const swapSlots = async (aId: string, bId: string) => {
    const a = posts.find((p) => p.id === aId);
    const b = posts.find((p) => p.id === bId);
    if (!a || !b || !a.scheduledAt || !b.scheduledAt) return;
    setPosts((prev) =>
      prev.map((p) =>
        p.id === aId
          ? { ...p, scheduledAt: b.scheduledAt }
          : p.id === bId
            ? { ...p, scheduledAt: a.scheduledAt }
            : p,
      ),
    );
    try {
      await Promise.all([
        api.patch(`/posts/targets/${aId}/reschedule`, { scheduledAt: b.scheduledAt }),
        api.patch(`/posts/targets/${bId}/reschedule`, { scheduledAt: a.scheduledAt }),
      ]);
    } finally {
      void loadPosts();
    }
  };

  /**
   * Flip whether a video counts toward the quota. Turning revision ON with
   * `replaceScheduled` also cancels whatever is still queued for the video
   * being replaced, so the new cut takes the slot instead of both posting.
   */
  const toggleRevision = async (asset: MediaAssetInfo, replaceScheduled: boolean) => {
    setRevBusy(asset.id);
    try {
      const res = await api.patch<MediaAssetInfo & { cancelledPosts: number }>(
        `/media/${asset.id}/revision`,
        { isRevision: !asset.isRevision, replaceScheduled },
      );
      if (res.cancelledPosts > 0) {
        setSavedFlash(`cancelled:${asset.id}:${res.cancelledPosts}`);
        setTimeout(() => setSavedFlash(null), 4000);
      }
    } finally {
      setRevBusy(null);
      setQuotaKey((k) => k + 1);
      void load();
      void loadPosts();
    }
  };

  /** Pull one platform's post out of the queue, leaving any siblings. */
  const removeFromQueue = async (targetId: string) => {
    setConfirmRemove(null);
    try {
      await api.del(`/posts/targets/${targetId}`);
    } finally {
      void loadPosts();
    }
  };

  const removeAsset = async (asset: MediaAssetInfo) => {
    await api.del(`/media/${asset.id}`);
    setDrafts((d) => {
      const next = { ...d };
      delete next[asset.id];
      return next;
    });
    setTitles((t) => {
      const next = { ...t };
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
              ? `Drop a video for ${selectedClient.name}. It gets transcribed and a title and description drafted, with the video left untouched.`
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
                <span className="mini">AI title &amp; description</span>
                <span className="mini">Video never re-encoded</span>
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
              const video = asset.status === "ready" ? fileUrl(asset.videoUrl) : null;
              const description =
                drafts[asset.id] ?? asset.draftCopy?.description ?? "";
              const title = titles[asset.id] ?? asset.draftCopy?.title ?? "";
              return (
                <div className="job glass-sm" key={asset.id}>
                  <div
                    className="thumb"
                    style={video ? { cursor: "pointer" } : undefined}
                    title={video ? "Play the video" : undefined}
                    onClick={() => {
                      if (video) onPreview(asset.name, video);
                    }}
                  >
                    {thumb && <img className="jobthumb-img" src={thumb} alt={asset.name} />}
                    {asset.durationSec != null && (
                      <span className="dur">{formatDuration(asset.durationSec)}</span>
                    )}
                    {video && (
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
                      {asset.isRevision && <span className="tag rev">Revision</span>}
                      {asset.status === "ready" && asset.hasTranscript && (
                        <span className="tag ok">Transcribed</span>
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
                        <label className="flabel" style={{ marginTop: 10 }}>
                          Title
                          <span className="hint">
                            YouTube title · Instagram &amp; TikTok caption
                          </span>
                        </label>
                        <input
                          className="field-in titlein"
                          value={title}
                          maxLength={300}
                          placeholder={
                            asset.draftCopy
                              ? "Title this video…"
                              : "Title this video. Add ANTHROPIC_API_KEY to get AI drafts."
                          }
                          onChange={(e) =>
                            setTitles((t) => ({ ...t, [asset.id]: e.target.value }))
                          }
                        />

                        <label className="flabel" style={{ marginTop: 12 }}>
                          Description
                        </label>
                        <div className="captionbox">
                          <textarea
                            value={description}
                            placeholder={
                              asset.draftCopy
                                ? "Edit the AI description…"
                                : "Write a description. Add ANTHROPIC_API_KEY to get AI drafts."
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

                    {/* Quota control: revisions do not spend a slot. */}
                    <div className="revrow">
                      <span
                        className={`revtoggle${asset.isRevision ? " on" : ""}`}
                        title={
                          asset.isRevision
                            ? "Counts as a revision, not a new video"
                            : "Counts toward this period's videos"
                        }
                        onClick={() => void toggleRevision(asset, false)}
                      >
                        <span className="knob" />
                        {revBusy === asset.id
                          ? "…"
                          : asset.isRevision
                            ? "Revision"
                            : "Counts toward quota"}
                      </span>
                      {!asset.isRevision && asset.revisionOfId && (
                        <span
                          className="link"
                          title="Mark as a revision and cancel what is still scheduled for the original"
                          onClick={() => void toggleRevision(asset, true)}
                        >
                          Replace the original
                        </span>
                      )}
                      {savedFlash?.startsWith(`cancelled:${asset.id}:`) && (
                        <span className="revflash">
                          cancelled {savedFlash.split(":")[2]} scheduled post
                          {savedFlash.split(":")[2] === "1" ? "" : "s"}
                        </span>
                      )}
                    </div>

                    <div className="schedrow">
                      <button className="btn ghost" onClick={() => void removeAsset(asset)}>
                        Delete
                      </button>
                      {asset.status === "ready" && (
                        <button
                          className="btn ghost"
                          onClick={() => void saveDraft(asset)}
                          disabled={
                            drafts[asset.id] === undefined && titles[asset.id] === undefined
                          }
                        >
                          {savedFlash === asset.id ? "Saved ✓" : "Save copy"}
                        </button>
                      )}
                      <button
                        className="btn"
                        style={
                          asset.status === "ready" && connectedCount > 0
                            ? { marginLeft: "auto" }
                            : { marginLeft: "auto", opacity: 0.55, cursor: "not-allowed" }
                        }
                        title={
                          asset.status !== "ready"
                            ? "Available once processing finishes"
                            : connectedCount === 0
                              ? "Connect platforms in Settings first"
                              : "Pick platforms and a time"
                        }
                        disabled={asset.status !== "ready" || connectedCount === 0}
                        onClick={() => setScheduling(asset)}
                      >
                        <svg>
                          <use href="#i-bolt" />
                        </svg>{" "}
                        Schedule
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            {selectedClient && (
              <div style={{ marginBottom: 16 }}>
                <QuotaCard
                  clientId={selectedClient.id}
                  clientName={selectedClient.name}
                  reloadKey={quotaKey}
                />
              </div>
            )}

            <div className="card glass">
              <div className="rowhead">
                <h3>Up next in queue</h3>
              </div>
              {posts.filter((p) => p.status === "scheduled" || p.status === "publishing")
                .length === 0 ? (
                <div className="empty">
                  <div className="eic">
                    <svg>
                      <use href="#i-image" />
                    </svg>
                  </div>
                  <b>Nothing queued yet</b>
                  <p>Schedule a processed video and it will line up here.</p>
                </div>
              ) : (
                posts
                  .filter((p) => p.status === "scheduled" || p.status === "publishing")
                  .slice(0, 6)
                  .map((p) => (
                    <div
                      className={`queue-item${overTargetId === p.id ? " dragover" : ""}${
                        dragTargetId === p.id ? " dragging" : ""
                      }`}
                      key={p.id}
                      draggable={p.status === "scheduled"}
                      title={
                        p.status === "scheduled"
                          ? "Drag onto another queued post to swap their times"
                          : undefined
                      }
                      onDragStart={() => setDragTargetId(p.id)}
                      onDragEnd={() => {
                        setDragTargetId(null);
                        setOverTargetId(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragTargetId || dragTargetId === p.id) return;
                        e.preventDefault();
                        setOverTargetId(p.id);
                      }}
                      onDragLeave={() => setOverTargetId((o) => (o === p.id ? null : o))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragTargetId;
                        setOverTargetId(null);
                        setDragTargetId(null);
                        if (from && from !== p.id) void swapSlots(from, p.id);
                      }}
                    >
                      <div
                        className="qthumb"
                        style={{
                          background: "linear-gradient(160deg,#31266b,#141f3f)",
                          backgroundSize: "cover",
                          backgroundImage: fileUrl(p.thumbUrl)
                            ? `url(${fileUrl(p.thumbUrl)})`
                            : undefined,
                        }}
                      />
                      <div className="qmeta">
                        <b>{p.assetName}</b>
                        <span>
                          <Pf p={PF_ID[p.platform]} size="sm" />{" "}
                          {p.status === "publishing" ? "publishing…" : fmtWhen(p.scheduledAt)}
                        </span>
                      </div>
                      {p.status === "scheduled" && (
                        <div className="qactions">
                          <div
                            className="iconbtn"
                            title="Change day and time"
                            onClick={() => setQueueDetail(p)}
                          >
                            <svg>
                              <use href="#i-cal" />
                            </svg>
                          </div>
                          <div
                            className={`iconbtn${confirmRemove === p.id ? " danger" : ""}`}
                            title={
                              confirmRemove === p.id
                                ? "Click again to remove"
                                : "Remove from queue"
                            }
                            onClick={() => {
                              if (confirmRemove === p.id) void removeFromQueue(p.id);
                              else {
                                setConfirmRemove(p.id);
                                setTimeout(
                                  () => setConfirmRemove((c) => (c === p.id ? null : c)),
                                  4000,
                                );
                              }
                            }}
                          >
                            <svg style={{ stroke: "var(--red)" }}>
                              <use href="#i-x" />
                            </svg>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
              )}
            </div>

            <div className="card glass" style={{ marginTop: 16 }}>
              <h3>
                <svg
                  style={{ width: 16, height: 16, stroke: "var(--v)", fill: "none", strokeWidth: 2 }}
                  viewBox="0 0 24 24"
                >
                  <use href="#i-bolt" />
                </svg>{" "}
                Best times to post
              </h3>
              <div className="sub" style={{ marginBottom: 10 }}>
                Measured from {selectedClient?.name ?? "this brand"}'s own results
              </div>
              <BestTimes posts={bestTimePosts} />
            </div>
          </div>
        </div>
      </div>

      {scheduling && (
        <ScheduleModal
          asset={scheduling}
          onClose={() => setScheduling(null)}
          onScheduled={() => void loadPosts()}
        />
      )}

      {queueDetail && (
        <PostDetailModal
          target={queueDetail}
          onClose={() => setQueueDetail(null)}
          onChanged={() => void loadPosts()}
        />
      )}
    </section>
  );
}
