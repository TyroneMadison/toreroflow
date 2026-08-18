import { useEffect, useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import Select from "../components/Select";
import { useToast } from "../components/Toasts";
import {
  api,
  videoLabel,
  type AudioCatalog,
  type AudioTrack,
  type MediaAssetInfo,
  type YouTubePlaylistInfo,
} from "../lib/api";
import { PF_ID, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import { INSTAGRAM_REEL_MAX_SECONDS } from "@toreroflow/core";

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
  const isCarousel = asset.kind === "carousel";
  // A carousel can only go where images go: Instagram takes up to 10 as a
  // media list, TikTok takes them as a photo post. Offering the rest here
  // would only bounce off the server's refusal at schedule time.
  const connected = (selectedClient?.accounts ?? []).filter(
    (a) =>
      a.status === "connected" &&
      (!isCarousel || a.platform === "instagram" || a.platform === "tiktok"),
  );
  // The exact accounts ticked. Platform alone stopped being an address the
  // day a client got a second page on the same platform.
  const [accountIds, setAccountIds] = useState<string[]>(connected.map((a) => a.id));
  const platforms = [
    ...new Set(
      connected.filter((a) => accountIds.includes(a.id)).map((a) => a.platform),
    ),
  ] as Platform[];
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
  /** A catalog track, its two volumes, and the picker's own state. */
  const [igTrack, setIgTrack] = useState<AudioTrack | null>(null);
  const [igAudioVolume, setIgAudioVolume] = useState(100);
  const [igVideoVolume, setIgVideoVolume] = useState(100);
  const [igAudioOpen, setIgAudioOpen] = useState(false);
  const [igAudioType, setIgAudioType] = useState<"music" | "original_sound">("music");
  const [igAudioSearch, setIgAudioSearch] = useState("");
  const [igCatalog, setIgCatalog] = useState<AudioCatalog | null>(null);
  const [igAudioBusy, setIgAudioBusy] = useState(false);
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
  const [ytPlaylists, setYtPlaylists] = useState<YouTubePlaylistInfo[] | null>(null);

  // The reel options make no sense on a set of images, so a carousel shows
  // neither the Instagram nor the YouTube section.
  const igSelected = platforms.includes("instagram") && !isCarousel;
  const ytSelected = platforms.includes("youtube") && !isCarousel;
  /*
   * Catalog audio is a Reels feature and nothing else. A video too long to be
   * a reel goes as a feed post, which Instagram refuses audio on at creation,
   * so the picker is hidden rather than offering a choice that fails at
   * publish. Same rule and same threshold as buildPostExtras, which is what
   * actually decides. A null duration is treated as a reel, matching it.
   */
  const igReel =
    igSelected &&
    (asset.durationSec == null || asset.durationSec <= INSTAGRAM_REEL_MAX_SECONDS);
  /** The catalog is per account; the first Instagram target owns the lookup. */
  const igAccountId =
    connected.find((a) => a.platform === "instagram" && accountIds.includes(a.id))?.id ?? null;
  const tkCarousel = isCarousel && platforms.includes("tiktok");
  const [tkAutoMusic, setTkAutoMusic] = useState(false);

  // Playlists load once, the first time the YouTube section shows. A quiet
  // failure: the operator can always schedule without one.
  useEffect(() => {
    if (!ytSelected || !selectedClient || ytPlaylists !== null) return;
    api
      .get<{ playlists: YouTubePlaylistInfo[] }>(
        `/clients/${selectedClient.id}/external/youtube/playlists`,
      )
      .then((r) => setYtPlaylists(r.playlists))
      .catch(() => setYtPlaylists([]));
  }, [ytSelected, selectedClient, ytPlaylists]);

  /*
   * The catalog loads when the picker opens and again as the operator types.
   *
   * Debounced because every keystroke is a call that reaches Meta, and
   * cancelled on unmount so a slow search cannot land on a closed modal. The
   * unavailable answer is kept rather than discarded: it is what tells the UI
   * to draw the reconnect path instead of an empty list.
   */
  useEffect(() => {
    if (!igAudioOpen || !igAccountId) return;
    let cancelled = false;
    setIgAudioBusy(true);
    const timer = setTimeout(() => {
      const q = igAudioSearch.trim();
      api
        .get<AudioCatalog>(
          `/accounts/${igAccountId}/instagram/audio?audioType=${igAudioType}` +
            (q ? `&q=${encodeURIComponent(q)}` : ""),
        )
        .then((r) => {
          if (!cancelled) setIgCatalog(r);
        })
        .catch(() => {
          if (!cancelled) setIgCatalog({ available: true, tracks: [] });
        })
        .finally(() => {
          if (!cancelled) setIgAudioBusy(false);
        });
    }, igAudioSearch.trim() ? 350 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [igAudioOpen, igAccountId, igAudioSearch, igAudioType]);

  /*
   * Hands back a Facebook-login connect link for the client to click.
   *
   * Copied rather than opened, the same call as the YouTube direct-access link:
   * authorizing here would bind whichever Instagram this machine is signed into
   * rather than the client's.
   */
  const copyFacebookReconnect = async () => {
    if (!igAccountId) return;
    try {
      const { authUrl } = await api.post<{ authUrl: string }>(
        `/accounts/${igAccountId}/facebook-reconnect`,
        {},
      );
      await navigator.clipboard.writeText(authUrl);
      toast.success("Reconnect link copied. Send it to the account owner.");
    } catch (error) {
      toast.fail("Could not build the reconnect link", error);
    }
  };

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
    // The picker is hidden off a reel, but a track chosen before the duration
    // ruled one out would still be in state, so the gate is repeated here.
    if (igTrack && igReel) {
      body.audioId = igTrack.audioId;
      if (igAudioVolume !== 100) body.audioVolume = igAudioVolume;
      if (igVideoVolume !== 100) body.videoVolume = igVideoVolume;
    }
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
    return Object.keys(body).length ? body : undefined;
  };

  const toggle = (id: string) =>
    setAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
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
        accountIds,
        scheduledAt: (mode === "now" ? new Date() : new Date(when)).toISOString(),
        instagram: instagramBody(),
        youtube: youtubeBody(),
        ...(tkCarousel && tkAutoMusic ? { tiktok: { autoAddMusic: true } } : {}),
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
      {/* .modal-head is sticky with background:inherit, which on a .glass modal
          is a 5% white fill; scrolled body content showed through the title.
          Its blur(30px) cannot help either: the parent .glass already carries a
          backdrop-filter, so the child's samples behind the modal, not inside
          it. An opaque surface, rounded to the modal's own top corners. */}
      <div
        className="modal-head"
        style={{
          background: "var(--bg-1)",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          borderRadius: "var(--radius) var(--radius) 0 0",
        }}
      >
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
        <label className="flabel">Post at</label>
        <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />
        <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
          Posts with the title saved on this video. Each platform publishes
          independently with automatic retries.
        </p>

        <label className="flabel" style={{ marginTop: 18 }}>
          Platforms
        </label>
        {connected.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
            No connected platforms. Connect them in Settings first.
          </p>
        )}
        <div className="toggles" style={{ marginTop: 6 }}>
          {connected.map((account) => {
            const on = accountIds.includes(account.id);
            return (
              <div
                key={account.id}
                className={`pt${on ? " on" : ""}`}
                onClick={() => toggle(account.id)}
              >
                <Pf p={PF_ID[account.platform]} />
                <div className="info">
                  <b>
                    {SURFACE_LABEL[account.platform]}
                    {account.reminder && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: ".8px",
                          textTransform: "uppercase",
                          color: "var(--amber)",
                        }}
                        title="This account cannot auto-post. At post time the client gets the video and caption by email and posts it themselves."
                      >
                        reminder
                      </span>
                    )}
                  </b>
                  <span>@{account.handle}</span>
                </div>
                <div className="switch" />
              </div>
            );
          })}
        </div>

        {tkCarousel && (
          <div className="igopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              TikTok options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${tkAutoMusic ? " on" : ""}`}
                title="TikTok attaches one of its recommended tracks to the photo post. TikTok chooses the song; picking one from their library is not possible through any API."
                onClick={() => setTkAutoMusic((v) => !v)}
              >
                Let TikTok add music
              </span>
            </div>
            {tkAutoMusic && (
              <p className="insworking" style={{ marginTop: 8 }}>
                TikTok picks a recommended track itself. Choosing a specific song from their
                library is app-only; no API offers it.
              </p>
            )}
          </div>
        )}

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
              Catalog audio
              <span className="hint">
                {igReel
                  ? "a licensed track from Instagram's catalog, laid over the reel"
                  : "unavailable: this video is too long to be a reel, and Instagram refuses catalog audio on feed posts"}
              </span>
            </label>
            {igReel &&
              (igTrack ? (
                <>
                  <div className="igrow">
                    <span
                      className="revtoggle on"
                      title="Remove this track"
                      onClick={() => setIgTrack(null)}
                    >
                      {igTrack.title.slice(0, 40)}
                      {igTrack.artist ? ` — ${igTrack.artist}` : ""} ✕
                    </span>
                  </div>
                  {igTrack.previewUrl && (
                    <audio
                      controls
                      preload="none"
                      src={igTrack.previewUrl}
                      style={{ width: "100%", height: 32, marginTop: 8 }}
                    />
                  )}
                  <div className="igvols">
                    <label className="flabel">
                      Track volume<span className="hint">{igAudioVolume}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={igAudioVolume}
                      onChange={(e) => setIgAudioVolume(Number(e.target.value))}
                    />
                    <label className="flabel">
                      Video sound<span className="hint">{igVideoVolume}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={igVideoVolume}
                      onChange={(e) => setIgVideoVolume(Number(e.target.value))}
                    />
                  </div>
                </>
              ) : (
                <>
                  <span className="revtoggle" onClick={() => setIgAudioOpen((v) => !v)}>
                    {igAudioOpen ? "Close list" : "Choose a track"}
                  </span>
                  {igAudioOpen && (
                    <div style={{ marginTop: 8 }}>
                      {igCatalog && !igCatalog.available ? (
                        /*
                         * Not an error. The account publishes reels perfectly
                         * well; Meta simply serves audio only to Instagram
                         * accounts connected through Facebook Login, and the
                         * fix belongs to whoever owns the account.
                         */
                        <div className="igaudio-blocked">
                          <p>
                            {igCatalog.reason === "not_connected"
                              ? "This account is not connected to the publish provider yet."
                              : "Instagram only serves its audio catalog to accounts connected through Facebook. This one was connected the ordinary way, so it can publish reels but cannot reach any tracks."}
                          </p>
                          {igCatalog.reason === "facebook_login_required" && (
                            <span className="revtoggle" onClick={copyFacebookReconnect}>
                              Copy reconnect link
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="igrow">
                            <span
                              className={`revtoggle${igAudioType === "music" ? " on" : ""}`}
                              onClick={() => setIgAudioType("music")}
                            >
                              Music
                            </span>
                            <span
                              className={`revtoggle${igAudioType === "original_sound" ? " on" : ""}`}
                              onClick={() => setIgAudioType("original_sound")}
                            >
                              Original sounds
                            </span>
                          </div>
                          <input
                            className="field-in"
                            style={{ marginTop: 6 }}
                            placeholder="Search, or leave empty for what's trending"
                            value={igAudioSearch}
                            onChange={(e) => setIgAudioSearch(e.target.value)}
                          />
                          <div style={{ maxHeight: 210, overflowY: "auto", marginTop: 6 }}>
                            {igAudioBusy && (
                              <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>Searching…</p>
                            )}
                            {!igAudioBusy && igCatalog?.available && !igCatalog.tracks.length && (
                              <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
                                No tracks. Instagram's API catalog is smaller than the one in the
                                app, so a track you can see on your phone may simply not be
                                licensed for scheduling.
                              </p>
                            )}
                            {igCatalog?.available &&
                              igCatalog.tracks.slice(0, 40).map((t) => (
                                <div
                                  key={t.audioId}
                                  className="rrow"
                                  style={{ cursor: "pointer" }}
                                  onClick={() => {
                                    setIgTrack(t);
                                    setIgAudioOpen(false);
                                  }}
                                >
                                  <span className="t">
                                    {t.title}
                                    {t.artist ? ` — ${t.artist}` : ""}
                                  </span>
                                  <span className="v">
                                    {t.durationSec
                                      ? `${Math.floor(t.durationSec / 60)}:${String(
                                          t.durationSec % 60,
                                        ).padStart(2, "0")}`
                                      : ""}
                                  </span>
                                </div>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              ))}
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
          </div>
        )}

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
          disabled={busy !== null || accountIds.length === 0}
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
          disabled={busy !== null || accountIds.length === 0}
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
