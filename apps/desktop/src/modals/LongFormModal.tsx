import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import BestTimes from "../components/BestTimes";
import GlassDateTime from "../components/GlassDateTime";
import Select from "../components/Select";
import { useToast } from "../components/Toasts";
import {
  api,
  fileUrl,
  uploadCoverImage,
  type ClientPost,
  type MediaAssetInfo,
  type PlatformConnection,
  type YouTubePlaylistInfo,
} from "../lib/api";
import {
  AD_SUITABILITY,
  buildStudioTasks,
  COMMENT_DEFAULTS,
  YT_CATEGORIES,
  YT_LANGUAGES,
  ratioLabel,
  type CommentChoices,
} from "../lib/youtube";
import { scheduleTimeError } from "@toreroflow/core";
import { useAppState } from "../state/AppState";

interface LongFormModalProps {
  asset: MediaAssetInfo;
  onClose: () => void;
  onScheduled: () => void;
}

/** Local-time value for the picker, minutes precision. */
function localInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The five phases of the long-form upload, in Tyrone's order.
 *
 * The list is data so later pieces splice their phase in without touching the
 * navigation. A phase that is not live yet is shown but disabled, because a
 * stepper that silently grows steps release by release reads as a bug, while
 * one that shows where it is going reads as a plan.
 */
const PHASES = [
  { id: "details", label: "Details", live: true },
  { id: "suitability", label: "Ad suitability", live: true },
  { id: "elements", label: "Video elements", live: false },
  { id: "checks", label: "Checks", live: true },
  { id: "visibility", label: "Visibility", live: true },
] as const;
type PhaseId = (typeof PHASES)[number]["id"];

/** YouTube counts the tag pool as the tags joined with commas, capped at 500. */
const TAG_POOL_MAX = 500;

type Visibility = "public" | "unlisted" | "private" | "members";

/**
 * The long-form YouTube uploader: one video, one platform, five phases.
 *
 * This replaces the short-form scheduler for horizontal video, and it is
 * built on one standing rule from docs/longform-capability-map.md: a control
 * whose effect no API can execute is never drawn as if it publishes. What
 * ships in this piece is the executable set; the phases that are mostly
 * Studio-side (ad suitability, video elements) arrive with the machinery
 * that makes them honest.
 */
export default function LongFormModal({ asset, onClose, onScheduled }: LongFormModalProps) {
  const { selectedClient } = useAppState();
  const toast = useToast();

  /*
   * Long-form goes strictly to YouTube, which makes the account picker a
   * formality for every client with one channel and a real choice for the
   * rest. No YouTube account at all is a dead end worth saying plainly.
   */
  const ytAccounts = (selectedClient?.accounts ?? []).filter(
    (a) => a.platform === "youtube" && a.status === "connected",
  );
  const [accountId, setAccountId] = useState(ytAccounts[0]?.id ?? "");

  const [phase, setPhase] = useState<PhaseId>("details");
  const liveOrder: PhaseId[] = PHASES.filter((p) => p.live).map((p) => p.id);
  const stepIndex = liveOrder.indexOf(phase);

  // Details.
  const draft = asset.draftCopy;
  const [title, setTitle] = useState(draft?.youtubeTitle || draft?.name || asset.name);
  const [description, setDescription] = useState(draft?.youtubeDescription || "");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [showTags, setShowTags] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [playlists, setPlaylists] = useState<YouTubePlaylistInfo[] | null>(null);
  const [kids, setKids] = useState(false);
  const [paidPromotion, setPaidPromotion] = useState(false);
  const [aiLabel, setAiLabel] = useState(false);
  const [license, setLicense] = useState<"standard" | "creativeCommon">("standard");
  const [embeddable, setEmbeddable] = useState(true);
  const [recordingDate, setRecordingDate] = useState("");
  const [language, setLanguage] = useState("");
  // Studio-side settings: recorded here, executed by a human, per the
  // capability map. Defaults are YouTube's own, so only deviations turn into
  // finish-in-Studio tasks.
  const [studioOpen, setStudioOpen] = useState(false);
  const [comments, setComments] = useState<CommentChoices>(COMMENT_DEFAULTS);
  const [autoChapters, setAutoChapters] = useState(true);
  const [featuredPlaces, setFeaturedPlaces] = useState(true);
  const [autoConcepts, setAutoConcepts] = useState(true);
  const [fundraiserUrl, setFundraiserUrl] = useState("");
  const [collaborator, setCollaborator] = useState("");

  // Ad suitability. Editable until scheduled; Studio's own once-only lock is
  // explained on the phase rather than imitated, because our copy of the
  // rating is not the one Google holds.
  const [certFlags, setCertFlags] = useState<string[]>([]);
  const [certNone, setCertNone] = useState(false);
  const [certSubmitted, setCertSubmitted] = useState(false);

  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbName, setThumbName] = useState<string | null>(null);
  const [thumbPreview, setThumbPreview] = useState<string | null>(null);

  // Visibility.
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 10 * 60_000)));
  const [bestTimePosts, setBestTimePosts] = useState<ClientPost[]>([]);
  /** Direct channel connections; decides whether the enrichment can run. */
  const [connections, setConnections] = useState<PlatformConnection[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const tagPool = tags.join(",").length;
  const certRating: "safe" | "limited" = certFlags.length ? "limited" : "safe";
  /** Answering means flagging something or explicitly saying none applies. */
  const certAnswered = certNone || certFlags.length > 0;

  const toggleFlag = (key: string) => {
    setCertSubmitted(false);
    setCertNone(false);
    setCertFlags((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };
  const whenError = scheduleTimeError(new Date(when));

  // Playlists and the best-times history load once, quietly. Scheduling must
  // never depend on either arriving.
  useEffect(() => {
    if (!selectedClient) return;
    api
      .get<{ playlists: YouTubePlaylistInfo[] }>(
        `/clients/${selectedClient.id}/external/youtube/playlists`,
      )
      .then((r) => setPlaylists(r.playlists))
      .catch(() => setPlaylists([]));
    api
      .get<{ posts: ClientPost[] }>(`/clients/${selectedClient.id}/analytics/posts`)
      .then((r) => setBestTimePosts(r.posts))
      .catch(() => setBestTimePosts([]));
    api
      .get<{ connections: PlatformConnection[] }>(`/oauth/connections`)
      .then((r) => setConnections(r.connections))
      .catch(() => setConnections([]));
  }, [selectedClient]);

  const addTags = (raw: string) => {
    const parts = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setTags((prev) => {
      const seen = new Set(prev.map((t) => t.toLowerCase()));
      const next = [...prev];
      for (const p of parts) {
        if (!seen.has(p.toLowerCase())) {
          next.push(p);
          seen.add(p.toLowerCase());
        }
      }
      return next;
    });
    setTagInput("");
  };

  const pickThumbnail = async (file: File) => {
    setThumbBusy(true);
    try {
      await uploadCoverImage(asset.id, file);
      setThumbName(file.name);
      setThumbPreview(URL.createObjectURL(file));
    } catch (err) {
      toast.fail("Could not upload the thumbnail", err);
    } finally {
      setThumbBusy(false);
    }
  };

  /**
   * The Checks phase, computed fresh on every render.
   *
   * Honest preflight only: these are the things visible from this machine.
   * YouTube's own copyright check runs on their side after upload and has no
   * API to invoke earlier, so it is described, never simulated.
   */
  const checks = useMemo(() => {
    const rows: Array<{ ok: boolean | null; text: string }> = [];
    rows.push(
      ytAccounts.length
        ? { ok: true, text: `Publishing to @${ytAccounts.find((a) => a.id === accountId)?.handle ?? ytAccounts[0]?.handle}` }
        : { ok: false, text: "No YouTube account is connected for this client. Connect one in Settings." },
    );
    rows.push(
      title.trim().length === 0
        ? { ok: false, text: "The video has no title." }
        : title.length > 100
          ? { ok: false, text: `The title is ${title.length} characters; YouTube stops at 100.` }
          : { ok: true, text: `Title: ${title.length}/100 characters.` },
    );
    rows.push(
      description.length > 5000
        ? { ok: false, text: `The description is ${description.length} characters; YouTube stops at 5,000.` }
        : description.trim().length === 0
          ? { ok: null, text: "No description. It publishes, but search has nothing to read." }
          : { ok: true, text: `Description: ${description.length}/5,000 characters.` },
    );
    rows.push(
      tagPool > TAG_POOL_MAX
        ? { ok: false, text: `Tags use ${tagPool} of ${TAG_POOL_MAX} characters. Remove some.` }
        : { ok: true, text: tags.length ? `${tags.length} tags, ${tagPool}/${TAG_POOL_MAX} characters.` : "No tags. Fine; they carry little weight now." },
    );
    rows.push(
      thumbName
        ? { ok: true, text: `Thumbnail: ${thumbName}.` }
        : asset.coverOffsetMs != null
          ? { ok: true, text: "Thumbnail: a frame picked from the video." }
          : { ok: null, text: "No thumbnail chosen; YouTube will pick a frame." },
    );
    if (asset.width && asset.height) {
      rows.push({
        ok: true,
        text: `${asset.width}x${asset.height} (${ratioLabel(asset.width, asset.height)}), ${Math.round(asset.durationSec ?? 0)}s. Long-form, horizontal.`,
      });
    }
    /*
     * Whether the after-publish half can actually run. Tags, license,
     * embedding, language, recording date and paid promotion are applied
     * through the channel's own connection, so a channel without one gets a
     * video with the wizard's words and none of those settings, silently,
     * unless it is said here. Informational rather than blocking, because
     * the video itself publishes fine either way.
     */
    const enrichWanted =
      tags.length > 0 ||
      license !== "standard" ||
      !embeddable ||
      recordingDate !== "" ||
      language !== "" ||
      paidPromotion;
    if (enrichWanted) {
      const connected = connections?.some(
        (c) => c.socialAccountId === accountId && c.platform === "youtube" && c.status === "active",
      );
      rows.push(
        connected
          ? {
              ok: true,
              text: "This channel is connected directly, so tags, license, embedding and the rest apply within a minute of publishing.",
            }
          : {
              ok: null,
              text:
                connections === null
                  ? "Checking the channel's direct connection…"
                  : "Tags, license, embedding and the like need the channel's own YouTube connection, and this channel has none yet. The video still publishes; those settings wait until the channel owner clicks a connect link (Settings, Direct data access).",
            },
      );
    }
    rows.push(
      certSubmitted
        ? {
            ok: true,
            text:
              certRating === "safe"
                ? "Ad suitability rated: none of the categories apply."
                : `Ad suitability rated: ${certFlags.length} categor${certFlags.length === 1 ? "y" : "ies"} flagged.`,
          }
        : {
            ok: false,
            text: "Ad suitability has not been rated. Go back to that phase and submit the rating.",
          },
    );
    rows.push({
      ok: null,
      text: "Copyright and monetization checks run on YouTube's side after upload; no API can run them earlier. Anything they flag appears in Studio.",
    });
    return rows;
  }, [ytAccounts, accountId, title, description, tagPool, tags, thumbName, asset, connections, license, embeddable, recordingDate, language, paidPromotion, certSubmitted, certRating, certFlags.length]);

  const checksBlock = checks.some((c) => c.ok === false);

  const submit = async () => {
    if (!selectedClient || !accountId) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Members-only is a Studio state, not an API one: privacyStatus knows
       * public, unlisted and private. Publishing private and saying what is
       * left to do is the honest mapping; publishing public and hoping is not.
       */
      const studioTasks = buildStudioTasks({
        membersOnly: visibility === "members",
        selfCert: certSubmitted ? { rating: certRating, flags: certFlags } : null,
        comments,
        autoChapters,
        featuredPlaces,
        autoConcepts,
        fundraiserUrl,
        collaborator,
      });
      await api.post(`/media/${asset.id}/schedule`, {
        platforms: ["youtube"],
        accountIds: [accountId],
        scheduledAt: new Date(when).toISOString(),
        youtube: {
          title: title.trim(),
          ...(description.trim() ? { description: description } : {}),
          visibility: visibility === "members" ? "private" : visibility,
          ...(kids ? { madeForKids: true } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(playlistId ? { playlistId } : {}),
          ...(aiLabel ? { aiLabel: true } : {}),
          ...(tags.length ? { tags } : {}),
          ...(license !== "standard" ? { license } : {}),
          ...(embeddable ? {} : { embeddable: false }),
          ...(recordingDate ? { recordingDate } : {}),
          ...(language ? { defaultLanguage: language } : {}),
          ...(paidPromotion ? { paidPromotion: true } : {}),
          ...(studioTasks.length ? { studioTasks } : {}),
          ...(certSubmitted ? { selfCert: { rating: certRating, flags: certFlags } } : {}),
        },
      });
      onScheduled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "scheduling failed");
      toast.fail("Could not schedule the video", err);
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (stepIndex < liveOrder.length - 1) setPhase(liveOrder[stepIndex + 1]!);
  };
  const back = () => {
    if (stepIndex > 0) setPhase(liveOrder[stepIndex - 1]!);
  };

  return (
    <Modal maxWidth={780} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Upload to YouTube</h3>
          <p>
            {asset.name} · long-form
            {asset.width && asset.height ? ` · ${ratioLabel(asset.width, asset.height)}` : ""}
          </p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>

      <div className="lfsteps">
        {PHASES.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`lfstep${p.id === phase ? " on" : ""}${p.live ? "" : " off"}`}
            disabled={!p.live}
            title={p.live ? undefined : "Arrives in a later build"}
            onClick={() => setPhase(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="modal-body lfbody" key={phase}>
        {phase === "details" && (
          <div className="lfphase">
            {ytAccounts.length === 0 && (
              <div className="autherr">
                This client has no connected YouTube account, so nothing here can publish.
                Connect one in Settings first.
              </div>
            )}
            {ytAccounts.length > 1 && (
              <>
                <label className="flabel">Channel</label>
                <Select
                  value={accountId}
                  onChange={setAccountId}
                  aria-label="Channel"
                  options={ytAccounts.map((a) => ({ value: a.id, label: `@${a.handle}` }))}
                />
              </>
            )}
            <label className="flabel" style={{ marginTop: ytAccounts.length > 1 ? 12 : 0 }}>
              Title<span className="hint">{title.length}/100</span>
            </label>
            <input
              className="field-in"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="The title viewers see"
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              Description<span className="hint">{description.length}/5,000</span>
            </label>
            <textarea
              className="field-in lfdesc"
              maxLength={5000}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell viewers what this video is about"
            />

            <div className="igrow" style={{ marginTop: 12 }}>
              <span className={`revtoggle${showTags ? " on" : ""}`} onClick={() => setShowTags((v) => !v)}>
                <span className="knob" />
                Tags
                <span className="hint">
                  {tags.length ? `${tags.length} · ${tagPool}/${TAG_POOL_MAX}` : "optional"}
                </span>
              </span>
            </div>
            {showTags && (
              <>
                <input
                  className="field-in"
                  style={{ marginTop: 6 }}
                  placeholder="Type a tag and press Enter, or paste a comma-separated list"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTags(tagInput);
                    }
                    if (e.key === "Backspace" && !tagInput && tags.length) {
                      setTags((prev) => prev.slice(0, -1));
                    }
                  }}
                  onBlur={() => addTags(tagInput)}
                />
                {tags.length > 0 && (
                  <div className="lftags">
                    {tags.map((t) => (
                      <span className="kw" key={t} onClick={() => setTags((prev) => prev.filter((x) => x !== t))}>
                        {t} ✕
                      </span>
                    ))}
                  </div>
                )}
                {tagPool > TAG_POOL_MAX && (
                  <p className="lnote">
                    Over YouTube's 500-character pool by {tagPool - TAG_POOL_MAX}. The Checks phase
                    will hold the upload until this fits.
                  </p>
                )}
              </>
            )}

            <label className="flabel" style={{ marginTop: 14 }}>
              Thumbnail
              <span className="hint">JPG or PNG, up to 2MB. Long-form takes a real thumbnail.</span>
            </label>
            <div className="lfthumbrow">
              {(thumbPreview ?? fileUrl(asset.thumbUrl)) && (
                <img className="lfthumb" src={thumbPreview ?? fileUrl(asset.thumbUrl)!} alt="" />
              )}
              <label className="revtoggle" style={{ cursor: "pointer" }}>
                {thumbBusy ? "Uploading…" : thumbName ? "Replace image" : "Upload an image"}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickThumbnail(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>

            <div className="dmgrid" style={{ marginTop: 14 }}>
              <div>
                <label className="flabel">Category</label>
                <Select
                  value={categoryId}
                  onChange={setCategoryId}
                  aria-label="Category"
                  options={[
                    { value: "", label: "Default (People & Blogs)" },
                    ...YT_CATEGORIES.map(([id, label]) => ({ value: id, label })),
                  ]}
                />
              </div>
              <div>
                <label className="flabel">Playlist</label>
                <Select
                  value={playlistId}
                  onChange={setPlaylistId}
                  aria-label="Playlist"
                  options={[
                    { value: "", label: playlists === null ? "Loading…" : "None" },
                    ...(playlists ?? []).map((p) => ({ value: p.id, label: p.title })),
                  ]}
                />
              </div>
              <div>
                <label className="flabel">
                  Video language
                  <span className="hint">what captions translate from</span>
                </label>
                <Select
                  value={language}
                  onChange={setLanguage}
                  aria-label="Video language"
                  options={[
                    { value: "", label: "Not set" },
                    ...YT_LANGUAGES.map(([tag, label]) => ({ value: tag, label })),
                  ]}
                />
              </div>
              <div>
                <label className="flabel">
                  Recording date
                  <span className="hint">viewers can search by it</span>
                </label>
                <input
                  className="field-in"
                  type="date"
                  value={recordingDate}
                  onChange={(e) => setRecordingDate(e.target.value)}
                />
              </div>
              <div>
                <label className="flabel">License</label>
                <Select
                  value={license}
                  onChange={(v) => setLicense(v as "standard" | "creativeCommon")}
                  aria-label="License"
                  options={[
                    { value: "standard", label: "Standard YouTube license" },
                    { value: "creativeCommon", label: "Creative Commons - Attribution" },
                  ]}
                />
              </div>
            </div>

            <div className="igrow" style={{ marginTop: 14 }}>
              <span className={`revtoggle${kids ? " on" : ""}`} onClick={() => setKids((v) => !v)}>
                <span className="knob" />
                Made for kids
              </span>
              <span
                className={`revtoggle${paidPromotion ? " on" : ""}`}
                onClick={() => setPaidPromotion((v) => !v)}
              >
                <span className="knob" />
                Paid promotion
              </span>
              <span className={`revtoggle${aiLabel ? " on" : ""}`} onClick={() => setAiLabel((v) => !v)}>
                <span className="knob" />
                Altered or AI content
              </span>
              <span
                className={`revtoggle${embeddable ? " on" : ""}`}
                onClick={() => setEmbeddable((v) => !v)}
              >
                <span className="knob" />
                Allow embedding
              </span>
            </div>
            <p className="lnote" style={{ marginTop: 10 }}>
              Tags, license, embedding, language, recording date and paid promotion are applied
              through the channel's own YouTube connection right after the video publishes; the
              rest goes up with the video itself.
            </p>

            <div className="igrow" style={{ marginTop: 12 }}>
              <span
                className={`revtoggle${studioOpen ? " on" : ""}`}
                onClick={() => setStudioOpen((v) => !v)}
              >
                <span className="knob" />
                Studio-side settings
                <span className="hint">comments, chapters, fundraiser, collaborator</span>
              </span>
            </div>
            {studioOpen && (
              <>
                <p className="lnote" style={{ marginTop: 8 }}>
                  None of these have an API, on any tool. Your choices here become the
                  finish-in-Studio list on the published post, two clicks from where a human
                  sets them. YouTube's own defaults are preselected, so only what you change
                  makes the list.
                </p>
                <div className="dmgrid" style={{ marginTop: 8 }}>
                  <div>
                    <label className="flabel">Comments</label>
                    <Select
                      value={comments.state}
                      onChange={(v) => setComments((c) => ({ ...c, state: v as CommentChoices["state"] }))}
                      aria-label="Comments"
                      options={[
                        { value: "on", label: "On" },
                        { value: "paused", label: "Paused" },
                        { value: "off", label: "Off" },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="flabel">Moderation</label>
                    <Select
                      value={comments.moderation}
                      onChange={(v) =>
                        setComments((c) => ({ ...c, moderation: v as CommentChoices["moderation"] }))
                      }
                      aria-label="Moderation"
                      options={[
                        { value: "basic", label: "Basic - hold potentially inappropriate" },
                        { value: "none", label: "None - don't hold any" },
                        { value: "strict", label: "Strict - hold a broader range" },
                        { value: "holdAll", label: "Hold all comments" },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="flabel">Who can comment</label>
                    <Select
                      value={comments.who}
                      onChange={(v) => setComments((c) => ({ ...c, who: v as CommentChoices["who"] }))}
                      aria-label="Who can comment"
                      options={[
                        { value: "anyone", label: "Anyone" },
                        { value: "subscribers", label: "Subscribers and members" },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="flabel">Sort by</label>
                    <Select
                      value={comments.sort}
                      onChange={(v) => setComments((c) => ({ ...c, sort: v as CommentChoices["sort"] }))}
                      aria-label="Sort by"
                      options={[
                        { value: "top", label: "Top comments" },
                        { value: "newest", label: "Newest first" },
                      ]}
                    />
                  </div>
                </div>
                <div className="igrow" style={{ marginTop: 10 }}>
                  <span
                    className={`revtoggle${autoChapters ? " on" : ""}`}
                    onClick={() => setAutoChapters((v) => !v)}
                  >
                    <span className="knob" />
                    Automatic chapters
                  </span>
                  <span
                    className={`revtoggle${featuredPlaces ? " on" : ""}`}
                    onClick={() => setFeaturedPlaces((v) => !v)}
                  >
                    <span className="knob" />
                    Featured places
                  </span>
                  <span
                    className={`revtoggle${autoConcepts ? " on" : ""}`}
                    onClick={() => setAutoConcepts((v) => !v)}
                  >
                    <span className="knob" />
                    Automatic concepts
                  </span>
                </div>
                <div className="dmgrid" style={{ marginTop: 10 }}>
                  <div>
                    <label className="flabel">
                      Fundraiser link<span className="hint">optional</span>
                    </label>
                    <input
                      className="field-in"
                      placeholder="https://…"
                      value={fundraiserUrl}
                      onChange={(e) => setFundraiserUrl(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="flabel">
                      Collaborator<span className="hint">optional</span>
                    </label>
                    <input
                      className="field-in"
                      placeholder="@handle or email"
                      value={collaborator}
                      onChange={(e) => setCollaborator(e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {phase === "suitability" && (
          <div className="lfphase">
            <p className="lnote" style={{ marginTop: 0 }}>
              Does your video contain any of the following, in the content, title, thumbnail or
              keywords? Rate it carefully: on a monetized channel this decides which ads run.
            </p>
            {AD_SUITABILITY.map((q) => (
              <div
                key={q.key}
                className={`lfcert${certFlags.includes(q.key) ? " on" : ""}${certNone ? " muted" : ""}`}
                onClick={() => toggleFlag(q.key)}
              >
                <span className="box">{certFlags.includes(q.key) ? "✓" : ""}</span>
                <span>
                  <b>{q.title}</b>
                  <i>{q.detail}</i>
                </span>
              </div>
            ))}
            <div className="igrow" style={{ marginTop: 12 }}>
              <span
                className={`revtoggle${certNone ? " on" : ""}`}
                onClick={() => {
                  setCertSubmitted(false);
                  setCertNone((v) => {
                    if (!v) setCertFlags([]);
                    return !v;
                  });
                }}
              >
                <span className="knob" />
                None of the above
              </span>
            </div>

            {certSubmitted ? (
              <div className={`lfrating ${certRating}`}>
                <b>
                  {certRating === "safe"
                    ? "✓ Suitable for most advertisers"
                    : "Limited or no ads likely"}
                </b>
                <span>
                  {certRating === "safe"
                    ? "Revenue sources on a monetized channel: ad revenue ✓ · YouTube Premium ✓ · merch and memberships ✓"
                    : `${certFlags.length} categor${certFlags.length === 1 ? "y" : "ies"} flagged. YouTube Premium and merch revenue continue; ad revenue is reduced or off.`}
                </span>
              </div>
            ) : (
              <button
                className="btn"
                style={{ marginTop: 12 }}
                disabled={!certAnswered}
                title={certAnswered ? undefined : "Flag a category, or choose none of the above"}
                onClick={() => setCertSubmitted(true)}
              >
                Submit rating
              </button>
            )}
            <p className="lnote" style={{ marginTop: 10 }}>
              Google offers no API for this rating, so it is not sent anywhere: it gates this
              wizard's Schedule button and prints on the post's finish-in-Studio list. In Studio
              itself a submitted rating cannot be changed, so carry these answers over exactly.
              Here you can edit until you schedule.
            </p>
          </div>
        )}

        {phase === "checks" && (
          <div className="lfphase">
            <p className="lnote" style={{ marginTop: 0 }}>
              Everything verifiable from here, before the upload spends a publish on it.
            </p>
            {checks.map((c, i) => (
              <div className="lfcheck" key={i}>
                <span className={`lfmark ${c.ok === true ? "ok" : c.ok === false ? "bad" : "info"}`}>
                  {c.ok === true ? "✓" : c.ok === false ? "✕" : "i"}
                </span>
                <span>{c.text}</span>
              </div>
            ))}
          </div>
        )}

        {phase === "visibility" && (
          <div className="lfphase">
            <label className="flabel">Visibility</label>
            <div className="igrow">
              {(
                [
                  ["public", "Public"],
                  ["unlisted", "Unlisted"],
                  ["private", "Private"],
                  ["members", "Members only"],
                ] as Array<[Visibility, string]>
              ).map(([value, label]) => (
                <span
                  key={value}
                  className={`revtoggle${visibility === value ? " on" : ""}`}
                  onClick={() => setVisibility(value)}
                >
                  {label}
                </span>
              ))}
            </div>
            {visibility === "members" && (
              <p className="lnote">
                YouTube's API can only publish public, unlisted or private, so this goes up
                private with a reminder to flip it to members-only in Studio. That reminder
                lands on the post's card once it publishes.
              </p>
            )}
            <label className="flabel" style={{ marginTop: 14 }}>
              Publish at
            </label>
            <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />
            {whenError && <div className="autherr">{whenError}</div>}
            <p className="lnote" style={{ marginTop: 6 }}>
              Before you publish: do kids appear in the video? If so, "Made for kids" back in
              Details is the setting reviewers look for.
            </p>
            <div style={{ marginTop: 14 }}>
              <BestTimes posts={bestTimePosts} />
            </div>
          </div>
        )}

        {error && (
          <div className="autherr" key={error}>
            {error}
          </div>
        )}
      </div>

      <div className="modal-foot">
        <button
          className={`btn ${confirmDiscard ? "danger" : "ghost"}`}
          style={{ marginRight: "auto" }}
          onClick={() => {
            if (confirmDiscard) onClose();
            else {
              setConfirmDiscard(true);
              setTimeout(() => setConfirmDiscard(false), 4000);
            }
          }}
        >
          {confirmDiscard ? "Discard for sure?" : "Discard"}
        </button>
        {stepIndex > 0 && (
          <button className="btn ghost" onClick={back}>
            Back
          </button>
        )}
        {stepIndex < liveOrder.length - 1 ? (
          <button
            className="btn"
            disabled={ytAccounts.length === 0 || (phase === "suitability" && !certSubmitted)}
            title={
              phase === "suitability" && !certSubmitted
                ? "Submit the rating to continue"
                : undefined
            }
            onClick={next}
          >
            Next
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || checksBlock || whenError !== null || ytAccounts.length === 0}
            title={checksBlock ? "The Checks phase is holding this: something above is red." : whenError ?? undefined}
            onClick={() => void submit()}
          >
            <svg>
              <use href="#i-bolt" />
            </svg>{" "}
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        )}
      </div>
    </Modal>
  );
}
