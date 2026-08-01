import { useEffect, useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import Select from "../components/Select";
import { useToast } from "../components/Toasts";
import {
  api,
  videoLabel,
  type CatalogueVideo,
  type MediaAssetInfo,
  type YouTubePlaylistInfo,
} from "../lib/api";
import { PF_ID, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface ScheduleModalProps {
  asset: MediaAssetInfo;
  onClose: () => void;
  onScheduled: () => void;
}

/** Local-time value for <input type="datetime-local">, minutes precision. */
function localInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** YouTube's stable category ids; Autos first because that is the clientele. */
const YT_CATEGORIES: Array<[string, string]> = [
  ["2", "Autos & Vehicles"],
  ["24", "Entertainment"],
  ["22", "People & Blogs"],
  ["26", "Howto & Style"],
  ["28", "Science & Technology"],
  ["27", "Education"],
  ["17", "Sports"],
  ["23", "Comedy"],
  ["10", "Music"],
  ["20", "Gaming"],
  ["19", "Travel & Events"],
  ["25", "News & Politics"],
  ["15", "Pets & Animals"],
  ["1", "Film & Animation"],
];

export default function ScheduleModal({ asset, onClose, onScheduled }: ScheduleModalProps) {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const connected = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected",
  );
  const [platforms, setPlatforms] = useState<Platform[]>(
    connected.map((a) => a.platform),
  );
  const [when, setWhen] = useState(() =>
    localInputValue(new Date(Date.now() + 10 * 60_000)),
  );
  const [busy, setBusy] = useState<"schedule" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);

  // Instagram-only options, applied to this scheduling action.
  const [igTrial, setIgTrial] = useState(false);
  const [igGraduate, setIgGraduate] = useState(false);
  const [igCollaborators, setIgCollaborators] = useState(["", "", ""]);
  const [igAudioName, setIgAudioName] = useState("");
  const [igShareToFeed, setIgShareToFeed] = useState(true);
  const [igFirstComment, setIgFirstComment] = useState("");
  const [igAiLabel, setIgAiLabel] = useState(false);
  /** A story is a second post, not a setting on the reel. */
  const [igAlsoStory, setIgAlsoStory] = useState(false);

  // YouTube-only options, applied to this scheduling action.
  const [ytVisibility, setYtVisibility] = useState("");
  const [ytKids, setYtKids] = useState(false);
  const [ytAiLabel, setYtAiLabel] = useState(false);
  const [ytFirstComment, setYtFirstComment] = useState("");
  const [ytCategoryId, setYtCategoryId] = useState("");
  const [ytPlaylistId, setYtPlaylistId] = useState("");
  const [ytRelated, setYtRelated] = useState<CatalogueVideo | null>(null);
  const [ytPickerOpen, setYtPickerOpen] = useState(false);
  const [ytSearch, setYtSearch] = useState("");
  const [ytCatalogue, setYtCatalogue] = useState<CatalogueVideo[] | null>(null);
  const [ytCatalogueFailed, setYtCatalogueFailed] = useState(false);
  const [ytPlaylists, setYtPlaylists] = useState<YouTubePlaylistInfo[] | null>(null);

  const igSelected = platforms.includes("instagram");
  const ytSelected = platforms.includes("youtube");

  // Catalogue and playlists load once, the first time the section shows.
  // Quiet failures: the operator can always schedule without either.
  useEffect(() => {
    if (!ytSelected || !selectedClient || ytCatalogue !== null) return;
    api
      .get<{ videos: CatalogueVideo[] }>(
        `/clients/${selectedClient.id}/external/youtube/videos`,
      )
      .then((r) => setYtCatalogue(r.videos))
      .catch(() => {
        setYtCatalogue([]);
        setYtCatalogueFailed(true);
      });
    api
      .get<{ playlists: YouTubePlaylistInfo[] }>(
        `/clients/${selectedClient.id}/external/youtube/playlists`,
      )
      .then((r) => setYtPlaylists(r.playlists))
      .catch(() => setYtPlaylists([]));
  }, [ytSelected, selectedClient, ytCatalogue]);

  /** Only what was actually chosen; untouched controls send nothing. */
  const instagramBody = () => {
    if (!igSelected) return undefined;
    const collaborators = igCollaborators
      .map((c) => c.trim().replace(/^@/, ""))
      .filter(Boolean);
    const body: Record<string, unknown> = {};
    if (igTrial) {
      body.trial = true;
      body.graduationStrategy = igGraduate ? "SS_PERFORMANCE" : "MANUAL";
    }
    if (collaborators.length) body.collaborators = collaborators;
    if (igAudioName.trim()) body.audioName = igAudioName.trim();
    if (!igShareToFeed) body.shareToFeed = false;
    if (igFirstComment.trim()) body.firstComment = igFirstComment.trim();
    if (igAiLabel) body.aiLabel = true;
    if (igAlsoStory) body.alsoStory = true;
    return Object.keys(body).length ? body : undefined;
  };

  /** Only what was actually chosen; untouched controls send nothing. */
  const youtubeBody = () => {
    if (!ytSelected) return undefined;
    const body: Record<string, unknown> = {};
    if (ytVisibility) body.visibility = ytVisibility;
    if (ytKids) body.madeForKids = true;
    if (ytFirstComment.trim() && !ytKids) body.firstComment = ytFirstComment.trim();
    if (ytCategoryId) body.categoryId = ytCategoryId;
    if (ytPlaylistId) body.playlistId = ytPlaylistId;
    if (ytAiLabel) body.aiLabel = true;
    if (ytRelated) {
      body.relatedVideoUrl =
        ytRelated.url ?? `https://www.youtube.com/watch?v=${ytRelated.platformVideoId}`;
    }
    return Object.keys(body).length ? body : undefined;
  };

  const toggle = (p: Platform) =>
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );

  /**
   * Publishing immediately is the same call with the time set to now; the
   * API turns a non-future time into a zero delay on the publish job.
   */
  const submit = async (mode: "schedule" | "now") => {
    setBusy(mode);
    setError(null);
    try {
      await api.post(`/media/${asset.id}/schedule`, {
        platforms,
        scheduledAt: (mode === "now" ? new Date() : new Date(when)).toISOString(),
        instagram: instagramBody(),
        youtube: youtubeBody(),
      });
      onScheduled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "scheduling failed");
      // The inline note carries a bare "Failed to fetch" on a dead API, which
      // reads as nothing at all next to an irreversible publish.
      toast.fail(
        mode === "now" ? "Could not publish the post" : "Could not schedule the post",
        err,
      );
      setConfirmNow(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal maxWidth={520} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Schedule post</h3>
          <p>{videoLabel(asset)}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <label className="flabel">Platforms</label>
        {connected.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
            No connected platforms. Connect them in Settings first.
          </p>
        )}
        <div className="toggles" style={{ marginTop: 6 }}>
          {connected.map((account) => {
            const on = platforms.includes(account.platform);
            return (
              <div
                key={account.id}
                className={`pt${on ? " on" : ""}`}
                onClick={() => toggle(account.platform)}
              >
                <Pf p={PF_ID[account.platform]} />
                <div className="info">
                  <b>{SURFACE_LABEL[account.platform]}</b>
                  <span>@{account.handle}</span>
                </div>
                <div className="switch" />
              </div>
            );
          })}
        </div>

        {igSelected && (
          <div className="igopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              Instagram options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${igTrial ? " on" : ""}`}
                title="Show this reel to non-followers first; it will not appear on the profile unless it graduates"
                onClick={() => setIgTrial((v) => !v)}
              >
                Trial reel
              </span>
              {igTrial && (
                <span
                  className={`revtoggle${igGraduate ? " on" : ""}`}
                  title="Share to everyone automatically if the trial performs"
                  onClick={() => setIgGraduate((v) => !v)}
                >
                  Auto-share if it performs
                </span>
              )}
              <span
                className={`revtoggle${igShareToFeed ? " on" : ""}`}
                title="Also show the reel in the main feed"
                onClick={() => setIgShareToFeed((v) => !v)}
              >
                Share to feed
              </span>
              <span
                className={`revtoggle${igAiLabel ? " on" : ""}`}
                title="Label this post as AI-generated content"
                onClick={() => setIgAiLabel((v) => !v)}
              >
                AI label
              </span>
              <span
                className={`revtoggle${igAlsoStory ? " on" : ""}`}
                title="Put this on the story as well, as a second post. Stories last 24 hours, show no caption, and must be 60 seconds or less."
                onClick={() => setIgAlsoStory((v) => !v)}
              >
                Also to story
              </span>
            </div>
            {igAlsoStory && (
              <p className="insworking" style={{ marginTop: 8 }}>
                Posts the video to the story as its own post alongside the reel. Instagram's
                "add post to your story", the one that shows a card linking back to the reel,
                cannot be done by any API, so this uploads the video itself. Stories disappear
                after 24 hours, show no caption, and Instagram refuses anything over 60 seconds.
              </p>
            )}
            <label className="flabel" style={{ marginTop: 12 }}>
              Collaborators
              <span className="hint">up to 3 public business or creator accounts</span>
            </label>
            <div className="igcollabs">
              {igCollaborators.map((value, i) => (
                <input
                  key={i}
                  className="field-in"
                  placeholder={`@username ${i + 1}`}
                  value={value}
                  onChange={(e) =>
                    setIgCollaborators((prev) =>
                      prev.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                />
              ))}
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Rename audio
              <span className="hint">replaces "Original Audio"</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. Torerone Original"
              maxLength={120}
              value={igAudioName}
              onChange={(e) => setIgAudioName(e.target.value)}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              First comment
              <span className="hint">posted automatically right after the reel</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. the hashtags, or a question for the comments"
              maxLength={2200}
              value={igFirstComment}
              onChange={(e) => setIgFirstComment(e.target.value)}
            />
          </div>
        )}

        {ytSelected && (
          <div className="ytopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              YouTube options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${ytKids ? " on" : ""}`}
                title="Declares the video made for kids. YouTube permanently disables comments, cards, and personalized ads on it"
                onClick={() => setYtKids((v) => !v)}
              >
                Made for kids
              </span>
              <span
                className={`revtoggle${ytAiLabel ? " on" : ""}`}
                title="Discloses altered or synthetic content"
                onClick={() => setYtAiLabel((v) => !v)}
              >
                AI label
              </span>
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Visibility
            </label>
            <Select
              value={ytVisibility}
              onChange={setYtVisibility}
              aria-label="Visibility"
              options={[
                { value: "", label: "Public (default)" },
                { value: "unlisted", label: "Unlisted" },
                { value: "private", label: "Private" },
              ]}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              Category
            </label>
            <Select
              value={ytCategoryId}
              onChange={setYtCategoryId}
              aria-label="Category"
              options={[
                { value: "", label: "Default (People & Blogs)" },
                ...YT_CATEGORIES.map(([id, label]) => ({ value: id, label })),
              ]}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              Playlist
            </label>
            {ytPlaylists && ytPlaylists.length > 0 ? (
              <Select
                value={ytPlaylistId}
                onChange={setYtPlaylistId}
                aria-label="Playlist"
                options={[
                  { value: "", label: "None" },
                  ...ytPlaylists.map((p) => ({ value: p.id, label: p.title })),
                ]}
              />
            ) : (
              <p style={{ fontSize: 12.5, color: "var(--txt-3)", marginTop: 4 }}>
                {ytPlaylists === null ? "Loading playlists…" : "No public playlists found."}
              </p>
            )}
            <label className="flabel" style={{ marginTop: 12 }}>
              First comment
              <span className="hint">
                {ytKids
                  ? "unavailable: made-for-kids videos have comments disabled"
                  : "posted and pinned automatically"}
              </span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. full build playlist on the channel"
              maxLength={10000}
              disabled={ytKids}
              value={ytFirstComment}
              onChange={(e) => setYtFirstComment(e.target.value)}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              Related video
              <span className="hint">
                adds a "Watch next" link at the end of the description. YouTube's own Related video
                pin has no API, so that one is still a manual step in Studio.
              </span>
            </label>
            {ytRelated ? (
              <div className="igrow">
                <span
                  className="revtoggle on"
                  title="Remove the related video"
                  onClick={() => setYtRelated(null)}
                >
                  {ytRelated.title.slice(0, 48)} ✕
                </span>
              </div>
            ) : (
              <>
                <span className="revtoggle" onClick={() => setYtPickerOpen((v) => !v)}>
                  {ytPickerOpen ? "Close list" : "Choose a video"}
                </span>
                {ytPickerOpen && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      className="field-in"
                      placeholder="Search the channel's videos"
                      value={ytSearch}
                      onChange={(e) => setYtSearch(e.target.value)}
                    />
                    <div style={{ maxHeight: 210, overflowY: "auto", marginTop: 6 }}>
                      {ytCatalogueFailed && (
                        <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
                          Could not load the catalogue. Try a refresh on Analytics first.
                        </p>
                      )}
                      {(ytCatalogue ?? [])
                        .filter((v) =>
                          v.title.toLowerCase().includes(ytSearch.trim().toLowerCase()),
                        )
                        .slice(0, 30)
                        .map((v) => (
                          <div
                            key={v.platformVideoId}
                            className="rrow"
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setYtRelated(v);
                              setYtPickerOpen(false);
                            }}
                          >
                            {v.thumbnailUrl && (
                              <img
                                src={v.thumbnailUrl}
                                alt=""
                                style={{
                                  width: 42,
                                  height: 24,
                                  objectFit: "cover",
                                  borderRadius: 4,
                                }}
                              />
                            )}
                            <span className="t">{v.title}</span>
                            <span className="v">
                              {v.views >= 1000 ? `${Math.round(v.views / 1000)}K` : v.views}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <label className="flabel" style={{ marginTop: 18 }}>
          Post at
        </label>
        <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />
        <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
          Posts with the title saved on this video. Each platform publishes
          independently with automatic retries.
        </p>

        {/* Keyed by the message so a second, different failure redraws. */}
        {error && (
          <div className="autherr" key={error}>
            <svg className="failmark" viewBox="0 0 52 52" aria-hidden="true">
              <circle cx="26" cy="26" r="23" />
              <path d="M18 18L34 34M34 18L18 34" />
            </svg>
            {error}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        {/* Publishing is irreversible, so Post now asks once before firing. */}
        <button
          className={`btn ${confirmNow ? "danger" : "ghost"}`}
          disabled={busy !== null || platforms.length === 0}
          onClick={() => {
            if (confirmNow) void submit("now");
            else {
              setConfirmNow(true);
              setTimeout(() => setConfirmNow(false), 4000);
            }
          }}
        >
          {busy === "now" ? "Publishing…" : confirmNow ? "Publish now?" : "Post now"}
        </button>
        <button
          className="btn"
          disabled={busy !== null || platforms.length === 0}
          onClick={() => void submit("schedule")}
        >
          <svg>
            <use href="#i-bolt" />
          </svg>{" "}
          {busy === "schedule" ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </Modal>
  );
}
