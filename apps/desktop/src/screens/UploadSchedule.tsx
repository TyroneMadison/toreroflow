import { linkProps, setQuery, useRoute } from "../lib/routes";
import { igLimitText, Seg } from "../components/PostDetails";
import { COMPOSER_TYPES, type ComposerType } from "../lib/postDetails";
import PhotoComposer from "../components/PhotoComposer";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  api,
  fileUrl,
  uploadMedia,
  videoLabel,
  type ClientPost,
  type MediaAssetInfo,
  type PostTargetInfo,
  type VideoFormat,
} from "../lib/api";
import { formatDuration } from "../lib/video";
import { queueRows } from "../lib/queue";
import { canMove } from "../lib/postStatus";
import { useAppState } from "../state/AppState";
import Pf from "../components/Pf";
import { PF_ID } from "../lib/platforms";
import ScheduleModal from "../modals/ScheduleModal";
import LongFormModal from "../modals/LongFormModal";
import PostDetailModal from "../modals/PostDetailModal";
import CoverModal from "../modals/CoverModal";
import { usesLongFormWizard } from "../lib/youtube";
import BestTimes from "../components/BestTimes";
import QuotaCard from "../components/QuotaCard";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";

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
  // Reading the file and pulling a thumbnail, and that is all. Neither the
  // transcript nor the AI copy is made here any more: both wait for the
  // "Generate caption and title" button, so an upload is only as slow as the
  // file itself.
  processing: "Getting it ready…",
  ready: "Ready",
  failed: "Processing failed",
};

export default function UploadSchedule({ onPreview, onOpenConnect }: UploadScheduleProps) {
  const { selectedClient, pendingCarouselDraft, setPendingCarouselDraft } = useAppState();
  const toast = useToast();
  const [assets, setAssets] = useState<MediaAssetInfo[]>([]);
  // The video list is the screen's primary load. The screen remounts per
  // brand, so "loaded" only ever goes false to true once per brand.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The asset whose description is being written, so one press at a time. */
  const [captioning, setCaptioning] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [ytTitles, setYtTitles] = useState<Record<string, string>>({});
  const [ytDescriptions, setYtDescriptions] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [departing, setDeparting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [posts, setPosts] = useState<PostTargetInfo[]>([]);
  const [scheduling, setSchedulingState] = useState<MediaAssetInfo | null>(null);
  // The open schedule flow is in the URL (?schedule=<asset id>), so a bot or a
  // shared link lands straight in it, and Back closes it.
  const setScheduling = (a: MediaAssetInfo | null) => {
    setSchedulingState(a);
    setQuery({ schedule: a?.id ?? null, ...(a ? {} : { step: null }) });
  };
  /** A video toggled to long-form, routed to the long-form wizard instead. */
  const [longForm, setLongFormState] = useState<MediaAssetInfo | null>(null);
  const setLongForm = (a: MediaAssetInfo | null) => {
    setLongFormState(a);
    setQuery({ schedule: a?.id ?? null, ...(a ? {} : { step: null, dest: null }) });
  };
  const { scheduleId: routeScheduleId } = useRoute();
  // Reopen the flow a deep link names, once its asset has loaded.
  useEffect(() => {
    if (!routeScheduleId || scheduling || longForm) return;
    const a = assets.find((x) => x.id === routeScheduleId && x.status === "ready");
    if (!a) return;
    if (usesLongFormWizard(a)) setLongFormState(a);
    else setSchedulingState(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeScheduleId, assets]);
  const [coverEditing, setCoverEditing] = useState<MediaAssetInfo | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [overTargetId, setOverTargetId] = useState<string | null>(null);
  const [queueDetail, setQueueDetail] = useState<PostTargetInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [bestTimePosts, setBestTimePosts] = useState<ClientPost[]>([]);
  const [quotaKey, setQuotaKey] = useState(0);
  /** The composer's post type. Images coming back from the Carousels tab land on Carousel. */
  const [ctype, setCtype] = useState<ComposerType>(pendingCarouselDraft ? "carousel" : "reel");
  /** Instagram's rolling 24 hour allowance, from Zernio, for the counter line. */
  const [igAllowance, setIgAllowance] = useState<{ used: number; total: number } | null>(null);
  const [revBusy, setRevBusy] = useState<string | null>(null);
  const [schedBusy, setSchedBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const departTimer = useRef<number | null>(null);

  const connectedCount = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected",
  ).length;

  const youtubeConnected = (selectedClient?.accounts ?? []).some(
    (a) => a.platform === "youtube" && a.status === "connected",
  );
  // Disclosure only: this decides whether the YouTube fields are on screen,
  // never where a video posts. Platform choice belongs to the schedule modal,
  // and a second picker here would be a source of truth that can disagree.
  const [ytOpen, setYtOpen] = useState<Record<string, boolean>>({});
  const ytPanelOpen = (assetId: string): boolean => ytOpen[assetId] ?? youtubeConnected;

  // One source for the queue's rows so the empty state and the list can
  // never disagree about what counts as queued.
  const queued = queueRows(posts);

  const loadPosts = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setPosts([]);
        return;
      }
      try {
        setPosts(await api.get<PostTargetInfo[]>(`/clients/${selectedClient.id}/posts`));
      } catch (err) {
        // Polls stay silent: the rows on screen are this brand's own. The
        // first load of a mount follows a switch or navigation, so that
        // failure is announced.
        if (opts?.announce) toast.fail("Could not load the queue", err);
      }
    },
    [selectedClient, toast],
  );

  useEffect(() => {
    void loadPosts({ announce: true });
    const t = setInterval(() => void loadPosts(), 15_000);
    return () => clearInterval(t);
  }, [loadPosts]);

  const load = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setAssets([]);
        return;
      }
      try {
        setAssets(await api.get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`));
        // The period counter is derived from these same videos, so any refresh
        // of the list can have moved it: an upload adds one, a delete removes
        // one, and processing finishing moves one out of unclassified into
        // short or long. Refreshing it here means no caller has to remember.
        setQuotaKey((k) => k + 1);
        setLoaded(true);
        setLoadError(false);
      } catch {
        // The first load fails into the screen's error state; later refreshes
        // stay silent over the list already on screen.
        if (opts?.announce) setLoadError(true);
      }
    },
    [selectedClient],
  );

  const state = !selectedClient ? "empty" : loadError ? "error" : loaded ? "ready" : "loading";

  useEffect(() => {
    void load({ announce: true });
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

  const hasInstagram = (selectedClient?.accounts ?? []).some(
    (a) => a.platform === "instagram" && a.status === "connected",
  );
  useEffect(() => {
    if (!selectedClient || !hasInstagram) return;
    let cancelled = false;
    api
      .get<{ limit: { used: number; total: number } | null }>(`/clients/${selectedClient.id}/instagram-limit`)
      .then((r) => !cancelled && setIgAllowance(r.limit))
      .catch(() => !cancelled && setIgAllowance(null));
    return () => {
      cancelled = true;
    };
  }, [selectedClient, hasInstagram]);
  const igLimit = igLimitText(igAllowance);
  const igLimitTotal = igAllowance?.total ?? null;

  /** Ready carousels not yet scheduled: the Carousels tab's finished images included. */
  const finished = assets.filter((a) => a.kind === "carousel" && a.status === "ready");

  // Poll while anything is still working its way through the pipeline.
  useEffect(() => {
    const busy = assets.some((a) => a.status === "uploaded" || a.status === "processing");
    if (!busy) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [assets, load]);

  /**
   * A brand switch cancels a farewell still in flight. Its refetch belongs
   * to the brand that just left the screen, and letting it land would paint
   * the previous brand's videos under the new brand's name. Keyed on the id
   * so a mere object identity change from a client-list refresh does not
   * cancel a legitimate animation.
   */
  useEffect(() => {
    return () => {
      if (departTimer.current !== null) {
        window.clearTimeout(departTimer.current);
        departTimer.current = null;
      }
      setDeparting(null);
    };
  }, [selectedClient?.id]);

  const addFiles = async (files: FileList | File[]) => {
    if (!selectedClient) return;
    const videos = Array.from(files).filter((f) => f.type.startsWith("video/"));
    for (const file of videos) {
      setUploadingNames((prev) => [...prev, file.name]);
      try {
        await uploadMedia(selectedClient.id, file);
      } catch (err) {
        // The card vanishes either way, so name the file that did not make it.
        toast.fail(`Could not upload ${file.name}`, err);
      } finally {
        setUploadingNames((prev) => prev.filter((n) => n !== file.name));
        void load();
      }
    }
  };

  /**
   * Several images as one post.
   *
   * Sent in one request so the whole set arrives or none of it does: a
   * carousel missing a slide would publish silently short.
   */
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  /** Persist whatever was typed. Returns false when the server refused. */
  /**
   * The one button that spends Anthropic money: transcribe if needed, then
   * write a title and description from what is said in the video. Nothing
   * runs automatically at upload any more, so nothing bills until this is
   * pressed.
   *
   * Fills the boxes rather than saving, so the operator reads the words
   * before they become what posts. Nothing is overwritten silently: existing
   * text is confirmed over first, because these are fields they may have
   * spent time on.
   */
  const writeCaption = async (asset: MediaAssetInfo) => {
    const hasTyped =
      (drafts[asset.id] ?? asset.draftCopy?.description ?? "").trim() !== "" ||
      (names[asset.id] ?? asset.draftCopy?.name ?? "").trim() !== "";
    if (hasTyped && !window.confirm("Replace the title and description already written?")) {
      return;
    }
    setCaptioning(asset.id);
    try {
      const out = await api.post<{ description: string; title: string; hashtags: string[] }>(
        `/media/${asset.id}/caption`,
        {},
      );
      if (!out.description.trim() && !out.title.trim()) {
        toast.fail("Nothing came back", new Error("the model returned no words"));
        return;
      }
      if (out.title.trim()) setNames((n) => ({ ...n, [asset.id]: out.title }));
      if (out.description.trim()) setDrafts((d) => ({ ...d, [asset.id]: out.description }));
      toast.success("Caption and title written. Read them, then save.");
      // The endpoint may have just transcribed the video and saved hashtags;
      // reload so the card reflects both.
      void load();
    } catch (err) {
      toast.fail("Could not write the caption", err);
    } finally {
      setCaptioning(null);
    }
  };

  const saveDraft = async (asset: MediaAssetInfo): Promise<boolean> => {
    const description = drafts[asset.id];
    const name = names[asset.id];
    const youtubeTitle = ytTitles[asset.id];
    const youtubeDescription = ytDescriptions[asset.id];
    if (
      description === undefined &&
      name === undefined &&
      youtubeTitle === undefined &&
      youtubeDescription === undefined
    ) {
      return true;
    }
    try {
      await api.patch(`/media/${asset.id}/draft`, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(youtubeTitle !== undefined ? { youtubeTitle } : {}),
        ...(youtubeDescription !== undefined ? { youtubeDescription } : {}),
      });
    } catch (err) {
      // Never flash "Saved" over copy the server rejected.
      toast.fail(`Could not save the copy for ${videoLabel(asset)}`, err);
      return false;
    }
    setSavedFlash(asset.id);
    setTimeout(() => setSavedFlash((s) => (s === asset.id ? null : s)), 2000);
    void load();
    return true;
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
    } catch (err) {
      // The reload below silently undoes the optimistic swap, so say why.
      toast.fail("Could not swap the two scheduled times", err);
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
    } catch (err) {
      toast.fail(
        replaceScheduled
          ? `Could not replace the original for ${asset.name}`
          : `Could not change how ${asset.name} counts toward the quota`,
        err,
      );
    } finally {
      setRevBusy(null);
      void load();
      void loadPosts();
    }
  };

  /** Reclassify which quota target a video spends. */
  const setFormat = async (asset: MediaAssetInfo, format: VideoFormat) => {
    if (asset.format === format) return;
    setRevBusy(asset.id);
    try {
      await api.patch(`/media/${asset.id}/format`, { format });
    } catch (err) {
      toast.fail(`Could not change the format for ${asset.name}`, err);
    } finally {
      setRevBusy(null);
      void load();
    }
  };

  /** Pull one platform's post out of the queue, leaving any siblings. */
  const removeFromQueue = async (targetId: string) => {
    setConfirmRemove(null);
    try {
      await api.del(`/posts/targets/${targetId}`);
    } catch (err) {
      toast.fail("Could not remove the post from the queue", err);
    } finally {
      void loadPosts();
      // The upload list holds only videos without a live post, so removing
      // one is what brings its card back. Without this the card returns
      // only after a navigation.
      void load();
    }
  };

  /*
   * The failure notices, all of them rather than the six rows on screen, so
   * "clear all" never leaves a hidden seventh behind. Dismissing deletes
   * nothing: the posts stay on the calendar, failed and retryable, and the
   * upcoming posts are the queue itself so they are never cleared.
   */
  const notices = posts.filter((p) => p.status === "failed" && !p.queueDismissed);

  const clearNotices = async () => {
    setClearing(true);
    try {
      await api.post("/posts/targets/dismiss", { targetIds: notices.map((p) => p.id) });
    } catch (err) {
      toast.fail("Could not clear the notifications", err);
    } finally {
      setClearing(false);
      void loadPosts();
    }
  };

  const removeAsset = async (asset: MediaAssetInfo) => {
    try {
      await api.del(`/media/${asset.id}`);
    } catch (err) {
      toast.fail(`Could not delete ${asset.name}`, err);
      return;
    }
    setDrafts((d) => {
      const next = { ...d };
      delete next[asset.id];
      return next;
    });
    setNames((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
    setYtTitles((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
    setYtDescriptions((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
    void load();
  };

  if (!selectedClient) {
    return (
      <section className="screen active" data-screen="upload" data-state={state}>
        <div className="topbar">
          <div className="h">
            <h2>Upload &amp; Schedule</h2>
          </div>
        </div>
        <div className="stage">
          <Empty
            screen="upload"
            title="No brand selected"
            hint="Pick or add a brand in the dock, then drop a video."
            action={
              <button type="button" className="btn" onClick={onOpenConnect} data-testid="upload.add-brand">
                Add a brand
              </button>
            }
          />
        </div>
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="upload" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Upload &amp; Schedule</h2>
          <p>
            {`Drop a video for ${selectedClient.name}. It gets transcribed and a title and description drafted, with the video left untouched.`}
          </p>
        </div>
      </div>
      <div className="stage">
        {/*
          One composer for every post type (mockup ig-05), full width.
          Reel is the video drop that was here before. Image and Carousel
          carry their own details and post time, so a picture goes from
          picked to scheduled in one press, with no card in between.
        */}
        <div className="postcomposer card glass" data-testid="composer">
          <div className="postcomposer-head">
            <h3>New post</h3>
            {igLimit && (
              <span className="postcomposer-limit" data-testid="composer-limit">
                {igLimit}
              </span>
            )}
          </div>
          <Seg
            label="Post type"
            value={ctype}
            onChange={setCtype}
            testId="composer-type"
            options={COMPOSER_TYPES}
          />

          {ctype === "reel" ? (
            <div
              className="drop"
              style={dragOver ? { borderColor: "rgba(255,111,97,.65)" } : undefined}
              role="button"
              tabIndex={0}
              aria-label="Add videos"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onClick={() => (selectedClient ? fileInput.current?.click() : onOpenConnect())}
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
          ) : (
            <PhotoComposer
              key={ctype}
              type={ctype}
              finished={finished}
              igLimitTotal={igLimitTotal}
              onOpenConnect={onOpenConnect}
              onDone={() => {
                void load();
                void loadPosts();
              }}
            />
          )}
        </div>

        {pendingCarouselDraft && (
          <p className="insworking" style={{ marginTop: 8 }}>
            Adding the images for "{pendingCarouselDraft.topic}" from the Carousels tab. Its
            caption and hashtags will be attached to the upload.{" "}
            <span
              className="link"
              onClick={() => setPendingCarouselDraft(null)}
              title="Upload these images without attaching that carousel's words"
            >
              Not these images? Detach.
            </span>
          </p>
        )}
        <div className="split">
          <div>

            {state === "loading" && <Loading screen="upload" label="Loading videos" />}
            {state === "error" && (
              <ErrorState
                screen="upload"
                message="Could not load this brand's videos. Check that the API is online, then try again."
                onRetry={() => {
                  setLoadError(false);
                  void load({ announce: true });
                }}
              />
            )}

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
              const name = names[asset.id] ?? asset.draftCopy?.name ?? "";
              const ytTitle = ytTitles[asset.id] ?? asset.draftCopy?.youtubeTitle ?? "";
              const ytDescription =
                ytDescriptions[asset.id] ?? asset.draftCopy?.youtubeDescription ?? "";
              return (
                <div
                  className={`jobwrap${departing === asset.id ? " departing" : ""}`}
                  key={asset.id}
                >
                  <div className="job glass-sm">
                    {departing === asset.id && (
                      <div className="schedok" aria-hidden="true">
                        <svg className="okmark" viewBox="0 0 52 52">
                          <circle cx="26" cy="26" r="23" />
                          <path d="M15 27l8 8 15-16" />
                        </svg>
                      </div>
                    )}
                  <div className="thumbcol">
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
                    {asset.status === "ready" && (
                      <button
                        className="btn ghost coverbtn"
                        onClick={() => setCoverEditing(asset)}
                      >
                        Edit cover
                      </button>
                    )}
                  </div>
                  <div className="body">
                    <div className="name">
                      <input
                        className="namein"
                        aria-label="Video name"
                        value={name}
                        maxLength={300}
                        placeholder="Name this video"
                        disabled={asset.status !== "ready"}
                        onChange={(e) =>
                          setNames((n) => ({ ...n, [asset.id]: e.target.value }))
                        }
                      />
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
                    <div className="filename" title={asset.name}>
                      {asset.name}
                    </div>

                    {asset.status !== "ready" ? (
                      <div className="transcript">
                        {asset.kind === "carousel" && asset.status !== "failed"
                          ? "Cutting the slides to shape…"
                          : STATUS_LABEL[asset.status]}
                      </div>
                    ) : (
                      <>
                        <label className="flabel withact" style={{ marginTop: 10 }}>
                          Description
                          <span className="hint">
                            Instagram, TikTok, Facebook and Snapchat caption
                          </span>
                          <span
                            className={`revtoggle${captioning === asset.id ? " on" : ""}`}
                            style={{ marginLeft: "auto" }}
                            title="Transcribes the video if needed, then writes a title, description and hashtags from what is said in it. This is the only thing that spends AI credit, and only when pressed."
                            onClick={() => {
                              if (captioning) return;
                              void writeCaption(asset);
                            }}
                          >
                            {captioning === asset.id
                              ? "Writing…"
                              : "Generate caption and title"}
                          </span>
                        </label>
                        <div className="captionbox">
                          <textarea
                            value={description}
                            placeholder={
                              asset.draftCopy ? "Edit the AI description…" : "Write a description."
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

                    {/* Short or long decides the door (scheduler or long-form
                        wizard, whatever the shape) and which quota it spends.
                        Unset reads as short-form, the default. */}
                    {asset.kind !== "carousel" && (
                      <div className="fmtseg">
                      <Seg
                        label={`Format of ${asset.name}`}
                        testId={`fmt-${asset.id}`}
                        value={asset.format ?? "short_form"}
                        options={[
                          { id: "short_form", label: "This is a short-form video" },
                          { id: "long_form", label: "This is a long-form video" },
                        ]}
                        onChange={(f) => void setFormat(asset, f)}
                      />
                      </div>
                    )}
                    {/* Revisions spend nothing. */}
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
                      {asset.status === "ready" && (
                        <span
                          className={`revtoggle${ytPanelOpen(asset.id) ? " on" : ""}`}
                          title="Show the title and description used for YouTube"
                          onClick={() =>
                            setYtOpen((o) => ({
                              ...o,
                              [asset.id]: !ytPanelOpen(asset.id),
                            }))
                          }
                        >
                          <span className="knob" />
                          YouTube
                        </span>
                      )}
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

                    {asset.status === "ready" && ytPanelOpen(asset.id) && (
                      <div className="ytpanel">
                        <label className="flabel">
                          Title for YouTube upload
                          <span className="hint">
                            falls back to the video's name
                          </span>
                        </label>
                        <input
                          className="field-in"
                          value={ytTitle}
                          maxLength={100}
                          placeholder="Title this YouTube upload"
                          onChange={(e) =>
                            setYtTitles((t) => ({ ...t, [asset.id]: e.target.value }))
                          }
                        />
                        <label className="flabel" style={{ marginTop: 12 }}>
                          Description
                          <span className="hint">
                            falls back to the description above
                          </span>
                        </label>
                        <div className="captionbox">
                          <textarea
                            value={ytDescription}
                            placeholder="Write the YouTube description"
                            onChange={(e) =>
                              setYtDescriptions((d) => ({
                                ...d,
                                [asset.id]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}

                    <div className="schedrow">
                      <button className="btn ghost" onClick={() => void removeAsset(asset)}>
                        Delete
                      </button>
                      {asset.status === "ready" && (
                        <button
                          className="btn ghost"
                          onClick={() => void saveDraft(asset)}
                          disabled={
                            drafts[asset.id] === undefined &&
                            names[asset.id] === undefined &&
                            ytTitles[asset.id] === undefined &&
                            ytDescriptions[asset.id] === undefined
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
                        disabled={
                          asset.status !== "ready" ||
                          connectedCount === 0 ||
                          schedBusy === asset.id
                        }
                        onClick={() => {
                          // What posts has to be what is on screen. saveDraft
                          // is a no-op when nothing was typed, and returns
                          // false when the server refused, in which case the
                          // modal stays shut rather than publishing older copy.
                          if (schedBusy) return;
                          setSchedBusy(asset.id);
                          void saveDraft(asset)
                            .then((ok) => {
                              // The short/long toggle alone decides the door.
                              if (ok) {
                                if (usesLongFormWizard(asset)) setLongForm(asset);
                                else setScheduling(asset);
                              }
                            })
                            .finally(() => setSchedBusy(null));
                        }}
                      >
                        <svg>
                          <use href="#i-bolt" />
                        </svg>{" "}
                        {schedBusy === asset.id ? "Saving..." : "Schedule"}
                      </button>
                    </div>
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
                {notices.length > 0 && (
                  <button
                    className="btn ghost"
                    style={{ fontSize: 11.5 }}
                    disabled={clearing}
                    title={`Clears ${notices.length} failure ${notices.length === 1 ? "notice" : "notices"} from this list. Nothing is removed from the calendar.`}
                    onClick={() => void clearNotices()}
                  >
                    {clearing ? "Clearing..." : "Clear all"}
                  </button>
                )}
              </div>
              {queued.length === 0 ? (
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
                queued.map((p) => (
                    <div
                      className={`queue-item${overTargetId === p.id ? " dragover" : ""}${
                        dragTargetId === p.id ? " dragging" : ""
                      }`}
                      key={p.id}
                      draggable={canMove(p.status)}
                      title={
                        canMove(p.status)
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
                        <b>
                          {p.assetName}
                          {p.assetKind === "carousel" && (
                            <span className="qcarousel" title="A carousel of images">
                              ▤ {p.slideCount || ""}
                            </span>
                          )}
                        </b>
                        <span className={p.status === "failed" ? "qfail" : undefined}>
                          <Pf p={PF_ID[p.platform]} size="sm" />{" "}
                          {p.status === "failed"
                            ? `Failed: ${p.error ?? "unknown error"}`
                            : p.status === "publishing"
                              ? "publishing…"
                              : fmtWhen(p.scheduledAt)}
                        </span>
                      </div>
                      {(p.status === "scheduled" || p.status === "failed") && (
                        <div className="qactions">
                          {p.status === "scheduled" && (
                            <div
                              className="iconbtn"
                              title="Change day and time"
                              onClick={() => setQueueDetail(p)}
                            >
                              <svg>
                                <use href="#i-cal" />
                              </svg>
                            </div>
                          )}
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
          onScheduled={() => {
            // The modal calls this and then closes, so `scheduling` still
            // holds the asset that just went out. The queue refreshes at
            // once; the card holds for its animation and only then refetches,
            // so the list ends up authoritative rather than merely looking
            // right.
            const departingId = scheduling?.id ?? null;
            void loadPosts();
            if (!departingId) return;
            setDeparting(departingId);
            if (departTimer.current !== null) window.clearTimeout(departTimer.current);
            const timer = window.setTimeout(() => {
              if (departTimer.current === timer) departTimer.current = null;
              // Hold the collapsed state until the refreshed list is in hand.
              // Dropping the class first lets a slow fetch re-inflate the card
              // and then pop it away with no animation at all.
              void load().finally(() => {
                setDeparting((d) => (d === departingId ? null : d));
              });
            }, 950);
            departTimer.current = timer;
          }}
        />
      )}

      {longForm && (
        <LongFormModal
          asset={longForm}
          onClose={() => setLongForm(null)}
          onScheduled={() => {
            const departingId = longForm?.id ?? null;
            void loadPosts();
            if (!departingId) return;
            setDeparting(departingId);
            if (departTimer.current !== null) window.clearTimeout(departTimer.current);
            const timer = window.setTimeout(() => {
              if (departTimer.current === timer) departTimer.current = null;
              void load().finally(() => {
                setDeparting((d) => (d === departingId ? null : d));
              });
            }, 950);
            departTimer.current = timer;
          }}
        />
      )}

      {queueDetail && (
        <PostDetailModal
          target={queueDetail}
          onClose={() => setQueueDetail(null)}
          onChanged={() => void loadPosts()}
        />
      )}

      {coverEditing && (
        <CoverModal
          asset={coverEditing}
          onClose={() => setCoverEditing(null)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}
