import { useCallback, useEffect, useState } from "react";
import Modal from "./Modal";
import CoverModal from "./CoverModal";
import PreviewModal from "./PreviewModal";
import { useToast } from "../components/Toasts";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import { api, fileUrl, uploadAbThumb, type MediaAssetInfo, type PostTargetInfo } from "../lib/api";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";
import { canMove, POST_STATUS } from "../lib/postStatus";
import { explainPublishFailure, scheduleTimeError } from "@toreroflow/core";

interface PostDetailModalProps {
  /** The platform the panel opens on: its caption, status and actions show first. */
  target: PostTargetInfo;
  /**
   * Every platform of the same post, `target` included, when the opener knows
   * them. Each gets a row with its own status and its own time. Absent, the
   * panel is about `target` alone.
   */
  siblings?: PostTargetInfo[];
  /**
   * Every post the opener has loaded. Turns on "use this caption on every
   * post that day" for the open platform's day; absent, the button is absent.
   */
  knownTargets?: PostTargetInfo[];
  onClose(): void;
  onChanged(): void;
}

type AbTest = NonNullable<NonNullable<PostTargetInfo["youtube"]>["abTest"]>;

/** Local datetime value ("YYYY-MM-DDTHH:mm") for the picker. */
function localValue(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Wider than moving: a failed post cannot move, but its words can change
// before a retry.
const captionEditableFor = (t: PostTargetInfo) => t.status === "scheduled" || t.status === "failed";
const ytTitleEditableFor = (t: PostTargetInfo) => t.platform === "youtube" && captionEditableFor(t);

/**
 * One post from the calendar: every platform it goes to, each with its own
 * status and its own day and time, editable while that platform is still
 * scheduled. The caption, title and actions below follow the platform picked
 * in the list. Published and in-flight platforms are read-only.
 */
export default function PostDetailModal({
  target: opened,
  siblings,
  knownTargets,
  onClose,
  onChanged,
}: PostDetailModalProps) {
  const toast = useToast();
  const platforms = siblings?.length ? siblings : [opened];
  const multi = platforms.length > 1;
  const [activeId, setActiveId] = useState(opened.id);
  /** The platform picked in the list. Everything below the list is about it. */
  const target = platforms.find((t) => t.id === activeId) ?? opened;
  const editable = canMove(target.status);

  /*
   * Edits are kept per platform, so picking another platform in the list
   * never throws away words or a time typed a moment before, and Save sends
   * every platform's changes at once.
   */
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [ytTitles, setYtTitles] = useState<Record<string, string>>({});
  const [whens, setWhens] = useState<Record<string, string>>({});
  const captionOf = (t: PostTargetInfo) => captions[t.id] ?? t.caption ?? "";
  const ytTitleOf = (t: PostTargetInfo) => ytTitles[t.id] ?? t.youtubeTitle ?? "";
  const whenOf = (t: PostTargetInfo) => whens[t.id] ?? localValue(t.scheduledAt);
  const captionDirtyFor = (t: PostTargetInfo) => captionEditableFor(t) && captionOf(t).trim() !== (t.caption ?? "").trim();
  const ytTitleDirtyFor = (t: PostTargetInfo) => ytTitleEditableFor(t) && ytTitleOf(t).trim() !== (t.youtubeTitle ?? "").trim();
  const ytTitleErrorFor = (t: PostTargetInfo) =>
    ytTitleDirtyFor(t) && !ytTitleOf(t).trim()
      ? "YouTube needs a title."
      : ytTitleOf(t).trim().length > 100
        ? "YouTube titles stop at 100 characters."
        : null;
  const whenDirtyFor = (t: PostTargetInfo) => canMove(t.status) && whenOf(t) !== localValue(t.scheduledAt);
  // Same staleness as the schedule modal: this one can sit open for a while
  // with a card's existing time already behind, so moving it has to be judged
  // against now rather than against what it was.
  const whenErrorFor = (t: PostTargetInfo) => (canMove(t.status) ? scheduleTimeError(new Date(whenOf(t))) : null);

  const captionEditable = captionEditableFor(target);
  const caption = captionOf(target);
  const setCaption = (v: string) => setCaptions((m) => ({ ...m, [target.id]: v }));
  // The name is the app's own label for the video, never published, so it
  // stays editable after posting. Blank is not a name: it would fall back to
  // the file name, which is what renaming exists to replace.
  const [name, setName] = useState(opened.assetName);
  const nameDirty = opened.mediaAssetId !== null && name.trim() !== opened.assetName.trim();
  const nameError = nameDirty && !name.trim() ? "The video needs a name." : null;
  const ytTitleEditable = ytTitleEditableFor(target);
  const ytTitle = ytTitleOf(target);
  const setYtTitle = (v: string) => setYtTitles((m) => ({ ...m, [target.id]: v }));
  const ytTitleError = ytTitleErrorFor(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retried, setRetried] = useState(false);

  /*
   * The video itself, for the preview and the cover picker, which both want
   * the full asset rather than the calendar's summary of it. Loaded on open
   * and again after a cover change, so the thumbnail here matches what will
   * post.
   */
  const [asset, setAsset] = useState<MediaAssetInfo | null>(null);
  const [viewing, setViewing] = useState<"preview" | "cover" | null>(null);
  const loadAsset = useCallback(async () => {
    if (!target.mediaAssetId) return;
    try {
      setAsset(await api.get<MediaAssetInfo>(`/media/${target.mediaAssetId}`));
    } catch {
      // The card still works without it; only preview and cover need it.
    }
  }, [target.mediaAssetId]);
  useEffect(() => {
    void loadAsset();
  }, [loadAsset]);
  const videoSrc = asset?.kind === "video" ? fileUrl(asset.videoUrl) : null;
  // A cover change only matters before it posts; after, the platform has its own.
  // Every platform of the video uses the cover, so it stays open while any of them has not gone out.
  const canCover = videoSrc !== null && platforms.some(captionEditableFor);

  const [writing, setWriting] = useState(false);
  /**
   * The same AI writer as the upload card, filling the boxes rather than
   * saving: the operator reads it, then saves. YouTube also gets the title.
   */
  const writeWithAi = async () => {
    if (!target.mediaAssetId) return;
    const hasWords = caption.trim() !== "" || (ytTitleEditable && ytTitle.trim() !== "");
    if (hasWords && !window.confirm("Replace what is written here with an AI draft?")) return;
    setWriting(true);
    setError(null);
    try {
      const out = await api.post<{ description: string; title: string }>(
        `/media/${target.mediaAssetId}/caption`,
        {},
      );
      if (!out.description.trim() && !out.title.trim()) {
        setError("The AI returned no words. Try again, or write it yourself.");
        return;
      }
      if (out.description.trim()) setCaption(out.description);
      if (ytTitleEditable && out.title.trim()) setYtTitle(out.title.slice(0, 100));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not write the caption");
    } finally {
      setWriting(false);
    }
  };

  /*
   * The rest of this post's day, for the one-caption-everywhere button. Only
   * posts that can still change count, so the number on the button is the
   * number that will change (the server also skips Instagram stories, which
   * never show a caption, and says so in the result).
   */
  const sameDay = (knownTargets ?? []).filter(
    (t) =>
      (t.status === "scheduled" || t.status === "failed") &&
      t.scheduledAt !== null &&
      target.scheduledAt !== null &&
      // Same local-day rule the calendar uses to place cards.
      new Date(t.scheduledAt).toDateString() === new Date(target.scheduledAt).toDateString(),
  );
  const dayLabel = target.scheduledAt
    ? new Date(target.scheduledAt).toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "";
  const [confirmDay, setConfirmDay] = useState(false);

  /*
   * The thumbnail A/B test. The modal only collects the pieces and presses
   * start; the worker owns the rotation and the verdict, on the same daily
   * clock as the view capture it measures with.
   */
  const [abKeys, setAbKeys] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const [abBusy, setAbBusy] = useState<"a" | "b" | "start" | "cancel" | null>(null);
  const [abPeriod, setAbPeriod] = useState<3 | 5 | 7>(5);
  // Per platform, like the edits: a post can go to two YouTube channels.
  const [abTests, setAbTests] = useState<Record<string, AbTest | null>>({});
  const abTest = target.id in abTests ? (abTests[target.id] ?? null) : (target.youtube?.abTest ?? null);
  const setAbTest = (next: (t: AbTest | null) => AbTest | null) =>
    setAbTests((m) => ({
      ...m,
      [target.id]: next(target.id in m ? (m[target.id] ?? null) : (target.youtube?.abTest ?? null)),
    }));
  const canAbTest = target.platform === "youtube" && target.status === "posted";

  /** Picks a platform in the list. Half-finished actions belong to the old one, so they reset. */
  const select = (id: string) => {
    setActiveId(id);
    setConfirmDelete(false);
    setConfirmDay(false);
    setRetried(false);
    setAbKeys({ a: null, b: null });
  };

  const pickVariant = async (slot: "a" | "b", file: File) => {
    setAbBusy(slot);
    try {
      const r = await uploadAbThumb(target.id, slot, file);
      setAbKeys((k) => ({ ...k, [slot]: r.key }));
    } catch (err) {
      setError(err instanceof Error ? err.message : `could not upload variant ${slot.toUpperCase()}`);
    } finally {
      setAbBusy(null);
    }
  };

  const startAb = async () => {
    setAbBusy("start");
    setError(null);
    try {
      const r = await api.post<{ abTest: NonNullable<NonNullable<PostTargetInfo["youtube"]>["abTest"]> }>(
        `/posts/targets/${target.id}/ab-test`,
        { periodDays: abPeriod, aKey: abKeys.a, bKey: abKeys.b },
      );
      setAbTest(() => r.abTest);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start the test");
    } finally {
      setAbBusy(null);
    }
  };

  const cancelAb = async () => {
    setAbBusy("cancel");
    try {
      await api.del(`/posts/targets/${target.id}/ab-test`);
      setAbTest((t) => (t ? { ...t, state: "cancelled" } : t));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not cancel the test");
    } finally {
      setAbBusy(null);
    }
  };


  /*
   * Why it failed, and whether pressing anything can help.
   *
   * The raw provider string is kept below this rather than replaced: the
   * explanation is for deciding what to do, and the original is what gets
   * quoted to a platform's support when the explanation is not enough.
   */
  const failure = target.status === "failed" ? explainPublishFailure(target.error) : null;
  /*
   * The Studio edit page for a published YouTube video.
   *
   * A Short's "Related video" pin is absent from Google's videos resource and
   * from the provider, so no tool can set it. The schedule modal used to offer
   * a picker that wrote a link into the description instead, which was close
   * enough to the real thing to be mistaken for it and was removed for exactly
   * that reason. This is what is left, and it is honest: the pin is set by
   * hand, and from here that is two clicks rather than a hunt through a
   * channel of hundreds.
   */
  const studioUrl =
    target.platform === "youtube" && target.status === "posted" && target.remotePostId
      ? `https://studio.youtube.com/video/${target.remotePostId}/edit`
      : null;
  const canRetry = failure !== null && failure.outlook !== "never" && !retried;

  // The loaded asset's thumbnail follows a cover change; the summary's does not.
  const thumb = fileUrl(asset?.thumbUrl ?? target.thumbUrl);

  const movedTimes = platforms.filter(whenDirtyFor);
  // A stale time only blocks saving that time; a caption-only edit on a post
  // whose slot is about to fire must still go through.
  const timeError = movedTimes.map(whenErrorFor).find(Boolean) ?? null;
  const copyError = nameError ?? platforms.map(ytTitleErrorFor).find(Boolean) ?? null;
  const anyDirty =
    nameDirty || movedTimes.length > 0 || platforms.some((t) => captionDirtyFor(t) || ytTitleDirtyFor(t));
  const anyEditable =
    platforms.some((t) => canMove(t.status) || captionEditableFor(t)) || opened.mediaAssetId !== null;

  /**
   * Every edit on every platform, in one place so Save, Retry and the
   * day-wide caption all send the same things. Each platform's time goes
   * through its own reschedule, which refuses anything already posted,
   * publishing or locked.
   */
  const saveAll = async () => {
    // Retry reaches here too, and the draft route would accept a blank name.
    if (copyError ?? timeError) throw new Error((copyError ?? timeError)!);
    if (nameDirty) await api.patch(`/media/${opened.mediaAssetId}/draft`, { name: name.trim() });
    for (const t of platforms) {
      if (ytTitleDirtyFor(t)) await api.patch(`/posts/targets/${t.id}/youtube-title`, { title: ytTitleOf(t) });
      if (captionDirtyFor(t)) await api.patch(`/posts/targets/${t.id}/caption`, { caption: captionOf(t) });
    }
    for (const t of movedTimes) {
      await api.patch(`/posts/targets/${t.id}/reschedule`, { scheduledAt: new Date(whenOf(t)).toISOString() });
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAll();
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
      // Whatever landed before the failure shows behind the panel.
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /**
   * This caption onto every post that day, this one included.
   *
   * This post's other edits save first, so pressing this never throws away a
   * rename or a new time typed a moment before. Two presses, because it
   * overwrites captions on posts that are not open.
   */
  const applyToDay = async () => {
    setConfirmDay(false);
    setBusy(true);
    setError(null);
    try {
      await saveAll();
      const r = await api.post<{ updated: number; skipped: number }>(
        "/posts/targets/bulk-caption",
        { targetIds: sameDay.map((t) => t.id), caption },
      );
      toast.success(
        `Caption set on ${r.updated} ${r.updated === 1 ? "post" : "posts"} for ${dayLabel}` +
          (r.skipped ? ` (${r.skipped} skipped: stories or already posting).` : "."),
      );
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not change the day's captions");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Puts it back on the queue, right now.
   *
   * `draft` is the TikTok inbox route, offered only on that platform's daily
   * cap. The modal closes on success because the target's status has changed
   * underneath it and the calendar is the thing that shows what happened next.
   */
  const retry = async (draft = false) => {
    setBusy(true);
    setError(null);
    try {
      // Retrying with new words is the point of editing a failed post, so
      // the edits go first rather than waiting on a separate Save. Every
      // platform's, so a time changed on a sibling is not lost when this closes.
      await saveAll();
      await api.post(`/posts/targets/${target.id}/retry`, draft ? { tiktokDraft: true } : {});
      setRetried(true);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not retry");
    } finally {
      setBusy(false);
    }
  };

  /** Removes just this platform's post; other platforms keep their slots. */
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/posts/targets/${target.id}`);
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not remove");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Modal maxWidth={multi ? 600 : 520} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>{target.assetName}</h3>
          <p>
            {multi
              ? [...new Set(platforms.map((t) => PLATFORM_LABELS[t.platform]))].join(", ")
              : `${PLATFORM_LABELS[target.platform]} · ${POST_STATUS[target.status].label}`}
          </p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>

      <div className="modal-body">
        <div className="pdrow">
          <div
            className="pdthumb"
            style={videoSrc ? { cursor: "pointer" } : undefined}
            title={videoSrc ? "Play the video" : undefined}
            onClick={() => {
              if (videoSrc) setViewing("preview");
            }}
          >
            {thumb && <img src={thumb} alt="" />}
          </div>
          <div className="pdmeta">
            <div className="line">
              <Pf p={PF_ID[target.platform]} size="sm" />
              <span>{PLATFORM_LABELS[target.platform]}</span>
            </div>
            <div className={`pdstatus ${target.status}`}>{POST_STATUS[target.status].label}</div>
            {videoSrc && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <button className="btn ghost" style={{ fontSize: 11.5 }} onClick={() => setViewing("preview")}>
                  <svg>
                    <use href="#i-play" />
                  </svg>{" "}
                  Preview
                </button>
                {canCover && (
                  <button
                    className="btn ghost"
                    style={{ fontSize: 11.5 }}
                    title="Pick a frame or upload an image. Every platform of this video uses it."
                    onClick={() => setViewing("cover")}
                  >
                    <svg>
                      <use href="#i-image" />
                    </svg>{" "}
                    Change cover
                  </button>
                )}
              </div>
            )}
            {target.publishedAt && (
              <div className="sub">
                Published {new Date(target.publishedAt).toLocaleString([], {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </div>
            )}
            {failure ? (
              <div className="pdfail">
                <div className="why">{failure.summary}</div>
                <div className="what">{failure.advice}</div>
                {target.error && <div className="raw">{target.error}</div>}
              </div>
            ) : target.error ? (
              /*
               * A message on a post that is not failed describes an attempt
               * that has already been dealt with, most often TikTok's shared
               * cap moving it past the reset. Drawing that in the red error
               * box would tell an operator something is broken when the post
               * is simply queued for later.
               */
              <div className="pdnote">{target.error}</div>
            ) : null}
          </div>
        </div>

        {/*
          One row per platform: which one, where it stands, and its own day
          and time. Only a scheduled platform can move; the server refuses
          the rest the same way. With several, a row is also the switch for
          the caption and actions below.
        */}
        <label className="flabel" style={{ marginTop: 16 }}>
          {multi ? "Platforms" : editable ? "Day and time" : "Scheduled for"}
        </label>
        <div className="pdpfs">
          {platforms.map((t) => {
            const on = multi && t.id === target.id;
            const whenError = whenErrorFor(t);
            const head = (
              <>
                <Pf p={PF_ID[t.platform]} size="sm" />
                <span className="pdpf-name">
                  {PLATFORM_LABELS[t.platform]}
                  {t.accountHandle && <small>@{t.accountHandle.replace(/^@/, "")}</small>}
                </span>
                <span className={`pdstatus ${t.status}`}>{POST_STATUS[t.status].label}</span>
              </>
            );
            return (
              <div key={t.id} className={`pdpf${on ? " on" : ""}`}>
                {multi ? (
                  <button
                    type="button"
                    className="pdpf-pick"
                    aria-pressed={on}
                    title={`Show the ${PLATFORM_LABELS[t.platform]} caption and status`}
                    onClick={() => select(t.id)}
                  >
                    {head}
                  </button>
                ) : (
                  <div className="pdpf-pick">{head}</div>
                )}
                <div className="pdpf-when">
                  {canMove(t.status) ? (
                    <GlassDateTime
                      value={whenOf(t)}
                      onChange={(v) => setWhens((m) => ({ ...m, [t.id]: v }))}
                      minDate={new Date()}
                    />
                  ) : (
                    <div className="pdpf-fixed">
                      {t.scheduledAt
                        ? new Date(t.scheduledAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" })
                        : "not scheduled"}
                    </div>
                  )}
                  {whenError && <div className="autherr">{whenError}</div>}
                </div>
              </div>
            );
          })}
        </div>
        {platforms.some((t) => !canMove(t.status)) && (
          <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
            Only scheduled posts can be moved.
          </p>
        )}

        {target.youtube && (target.youtube.studioTasks.length > 0 || target.youtube.enrich) && (
          <div className="pdtasks">
            {target.youtube.enrich && (
              <div className={`pdenrich ${target.youtube.enrich.state}`}>
                {target.youtube.enrich.state === "applied"
                  ? "Tags, license and the other API-side settings were applied automatically."
                  : target.youtube.enrich.state === "pending"
                    ? "Tags, license and the other API-side settings apply within a minute of publishing."
                    : target.youtube.enrich.detail}
              </div>
            )}
            {target.youtube.studioTasks.length > 0 && (
              <>
                <div className="tt">Finish in Studio</div>
                <ul>
                  {target.youtube.studioTasks.map((task, i) => (
                    <li key={i}>{task}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {canAbTest && (
          <div className="pdab">
            <div className="tt">Thumbnail A/B test</div>
            {!abTest || abTest.state === "cancelled" ? (
              <>
                <p className="what">
                  Two images, {abPeriod} days each, measured by this video's own daily view
                  capture. Make variant A the image that is live today; swaps happen on the
                  worker's daily pass. Views/day folds impressions in with click-through, so a
                  narrow verdict is noise.
                </p>
                <div className="igrow">
                  {(["a", "b"] as const).map((slot) => (
                    <label key={slot} className={`revtoggle${abKeys[slot] ? " on" : ""}`} style={{ cursor: "pointer" }}>
                      {abBusy === slot
                        ? "Uploading…"
                        : abKeys[slot]
                          ? `Variant ${slot.toUpperCase()} ready`
                          : `Upload variant ${slot.toUpperCase()}`}
                      <input
                        type="file"
                        accept="image/jpeg,image/png"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void pickVariant(slot, f);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  ))}
                  {([3, 5, 7] as const).map((d) => (
                    <span
                      key={d}
                      className={`revtoggle${abPeriod === d ? " on" : ""}`}
                      onClick={() => setAbPeriod(d)}
                    >
                      {d}d each
                    </span>
                  ))}
                  <button
                    className="btn"
                    disabled={!abKeys.a || !abKeys.b || abBusy !== null}
                    onClick={() => void startAb()}
                  >
                    {abBusy === "start" ? "Starting…" : "Start test"}
                  </button>
                </div>
              </>
            ) : abTest.state === "running" ? (
              <div className="igrow" style={{ alignItems: "center" }}>
                <span className="what" style={{ flex: 1 }}>
                  Running: variant {(abTest.applied ?? "a").toUpperCase()} is
                  {abTest.applied ? " live" : " queued for the next daily pass"} ·{" "}
                  {abTest.periodDays} days per variant.
                </span>
                <button className="btn ghost" disabled={abBusy !== null} onClick={() => void cancelAb()}>
                  {abBusy === "cancel" ? "Cancelling…" : "Cancel test"}
                </button>
              </div>
            ) : abTest.state === "done" ? (
              <p className="what">
                {abTest.result?.winner
                  ? `Winner: variant ${String(abTest.result.winner).toUpperCase()}, now live. `
                  : ""}
                {abTest.result?.note ?? "The test finished."}
              </p>
            ) : (
              <p className="what">{abTest.note ?? "The test stopped."}</p>
            )}
          </div>
        )}

        {studioUrl && (
          <div className="pdstudio">
            <div className="what">
              {target.youtube?.studioTasks.length
                ? "Everything on the list above is set on this video's own page in Studio."
                : "YouTube's Related video pin has no API, on any tool. If this Short should point at another video, set it here."}
            </div>
            <a className="btn ghost" href={studioUrl} target="_blank" rel="noreferrer">
              Open in YouTube Studio
            </a>
          </div>
        )}

        {target.mediaAssetId && (
          <>
            <label className="flabel" style={{ marginTop: 16 }}>
              Video name
            </label>
            <input
              className="field-in"
              maxLength={300}
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%" }}
            />
            {nameError ? (
              <div className="autherr">{nameError}</div>
            ) : (
              <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 6 }}>
                Your label in the app, on every platform this video is scheduled to. Never
                published.
              </p>
            )}
          </>
        )}

        {ytTitleEditable ? (
          <>
            <label className="flabel" style={{ marginTop: 16 }}>
              YouTube title
            </label>
            <input
              className="field-in"
              maxLength={100}
              value={ytTitle}
              onChange={(e) => setYtTitle(e.target.value)}
              placeholder="The title viewers see on YouTube"
              style={{ width: "100%" }}
            />
            {ytTitleError ? (
              <div className="autherr">{ytTitleError}</div>
            ) : (
              <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 6 }}>
                {ytTitle.trim().length}/100
              </p>
            )}
          </>
        ) : (
          target.youtubeTitle && (
            <>
              <label className="flabel" style={{ marginTop: 16 }}>
                YouTube title
              </label>
              <div className="pdcaption">{target.youtubeTitle}</div>
            </>
          )
        )}

        {captionEditable ? (
          <>
            <label className="flabel withact" style={{ marginTop: 16 }}>
              Caption for {PLATFORM_LABELS[target.platform]}
              {target.mediaAssetId && (
                <span
                  className={`revtoggle${writing ? " on" : ""}`}
                  style={{ marginLeft: "auto" }}
                  title={
                    ytTitleEditable
                      ? "Writes a caption and a YouTube title from what is said in the video. Read them, then save."
                      : "Writes a caption from what is said in the video. Read it, then save."
                  }
                  onClick={() => {
                    if (!writing) void writeWithAi();
                  }}
                >
                  {writing ? "Writing..." : "Write with AI"}
                </span>
              )}
            </label>
            <textarea
              className="field-in"
              rows={5}
              maxLength={5000}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="No caption"
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }}
            />
            {target.hashtags.length > 0 && (
              <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 6 }}>
                Added underneath when it posts:{" "}
                {target.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}
              </p>
            )}
            {sameDay.length > 1 && (
              <button
                className={`btn ghost${confirmDay ? " danger" : ""}`}
                style={{ fontSize: 11.5, marginTop: 8, ...(confirmDay ? { color: "var(--red)" } : {}) }}
                disabled={busy || copyError !== null || timeError !== null}
                title={`Replaces the caption on every scheduled post on ${dayLabel}, on every platform, with this one.`}
                onClick={() => {
                  if (confirmDay) void applyToDay();
                  else {
                    setConfirmDay(true);
                    setTimeout(() => setConfirmDay(false), 4000);
                  }
                }}
              >
                {confirmDay
                  ? `Sure? Replaces ${sameDay.length} captions`
                  : `Use this caption on all ${sameDay.length} posts on ${dayLabel}`}
              </button>
            )}
          </>
        ) : (
          target.caption && (
            <>
              <label className="flabel" style={{ marginTop: 16 }}>
                Caption
              </label>
              <div className="pdcaption">{target.caption}</div>
            </>
          )
        )}

        {error && <div className="autherr">{error}</div>}
      </div>

      <div className="modal-foot">
        {editable && (
          <button
            className={`btn ${confirmDelete ? "danger" : "ghost"}`}
            style={{ marginRight: "auto" }}
            disabled={busy}
            onClick={() => {
              if (confirmDelete) void remove();
              else {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 4000);
              }
            }}
          >
            <svg>
              <use href="#i-x" />
            </svg>{" "}
            {busy && confirmDelete
              ? "Removing…"
              : confirmDelete
                ? "Remove for sure?"
                : multi
                  ? `Remove ${PLATFORM_LABELS[target.platform]}`
                  : "Remove from schedule"}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>
          {anyEditable ? "Cancel" : "Close"}
        </button>
        {/*
          The inbox route sits beside Retry rather than replacing it, because
          the cap does lift at midnight and publishing straight to the account
          is still the better outcome when the operator can wait for it.
        */}
        {failure?.tiktokDailyCap && !retried && (
          <button className="btn ghost" disabled={busy} onClick={() => void retry(true)}>
            {busy ? "Sending…" : "Send to TikTok inbox"}
          </button>
        )}
        {canRetry && (
          <button className="btn" disabled={busy} onClick={() => void retry()}>
            <svg>
              <use href="#i-check" />
            </svg>{" "}
            {busy ? "Retrying…" : failure?.outlook === "later" ? "Retry anyway" : "Retry now"}
          </button>
        )}
        {anyEditable && (
          <button
            className="btn"
            // A stale time only blocks saving the time; a caption-only edit
            // on a post whose slot is about to fire must still go through.
            disabled={!anyDirty || busy || copyError !== null || timeError !== null}
            title={copyError ?? timeError ?? undefined}
            onClick={() => void save()}
          >
            <svg>
              <use href="#i-check" />
            </svg>{" "}
            {busy && !confirmDelete ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
    </Modal>
    {/*
      Siblings of the window rather than children: the glass panel's backdrop
      filter would trap a nested overlay inside its own box.
    */}
    {viewing === "preview" && videoSrc && (
      <PreviewModal name={target.assetName} url={videoSrc} onClose={() => setViewing(null)} />
    )}
    {viewing === "cover" && asset && (
      <CoverModal
        asset={asset}
        onClose={() => setViewing(null)}
        onChanged={() => {
          void loadAsset();
          onChanged();
        }}
      />
    )}
    </>
  );
}
