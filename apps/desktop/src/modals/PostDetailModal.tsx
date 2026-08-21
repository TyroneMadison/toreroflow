import { useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import { api, fileUrl, uploadAbThumb, type PostTargetInfo } from "../lib/api";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";
import { canMove, POST_STATUS } from "../lib/postStatus";
import { explainPublishFailure, scheduleTimeError } from "@toreroflow/core";

interface PostDetailModalProps {
  target: PostTargetInfo;
  onClose(): void;
  onChanged(): void;
}

/** Local datetime value ("YYYY-MM-DDTHH:mm") for the picker. */
function localValue(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Quick look at one scheduled post from the calendar, with its day and time
 * editable in place. Published and in-flight posts are read-only.
 */
export default function PostDetailModal({ target, onClose, onChanged }: PostDetailModalProps) {
  const editable = canMove(target.status);
  const [when, setWhen] = useState(() => localValue(target.scheduledAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retried, setRetried] = useState(false);

  /*
   * The thumbnail A/B test. The modal only collects the pieces and presses
   * start; the worker owns the rotation and the verdict, on the same daily
   * clock as the view capture it measures with.
   */
  const [abKeys, setAbKeys] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const [abBusy, setAbBusy] = useState<"a" | "b" | "start" | "cancel" | null>(null);
  const [abPeriod, setAbPeriod] = useState<3 | 5 | 7>(5);
  const [abTest, setAbTest] = useState(target.youtube?.abTest ?? null);
  const canAbTest = target.platform === "youtube" && target.status === "posted";

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
      setAbTest(r.abTest);
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

  const original = localValue(target.scheduledAt);
  const dirty = when !== original;
  // Same staleness as the schedule modal: this one can sit open for a while
  // with a card's existing time already behind, so moving it has to be judged
  // against now rather than against what it was.
  const whenError = editable ? scheduleTimeError(new Date(when)) : null;
  const thumb = fileUrl(target.thumbUrl);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/posts/targets/${target.id}/reschedule`, {
        scheduledAt: new Date(when).toISOString(),
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not reschedule");
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
    <Modal maxWidth={520} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>{target.assetName}</h3>
          <p>
            {PLATFORM_LABELS[target.platform]} · {POST_STATUS[target.status].label}
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
          <div className="pdthumb">
            {thumb && <img src={thumb} alt="" />}
          </div>
          <div className="pdmeta">
            <div className="line">
              <Pf p={PF_ID[target.platform]} size="sm" />
              <span>{PLATFORM_LABELS[target.platform]}</span>
            </div>
            <div className={`pdstatus ${target.status}`}>{POST_STATUS[target.status].label}</div>
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

        {target.caption && (
          <>
            <label className="flabel" style={{ marginTop: 16 }}>
              Caption
            </label>
            <div className="pdcaption">{target.caption}</div>
          </>
        )}

        <label className="flabel" style={{ marginTop: 16 }}>
          {editable ? "Day and time" : "Scheduled for"}
        </label>
        {editable ? (
          <>
            <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />
            {whenError && <div className="autherr">{whenError}</div>}
          </>
        ) : (
          <div className="pdcaption">
            {target.scheduledAt
              ? new Date(target.scheduledAt).toLocaleString([], {
                  dateStyle: "full",
                  timeStyle: "short",
                })
              : "not scheduled"}
          </div>
        )}
        {!editable && (
          <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
            Only scheduled posts can be moved.
          </p>
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
                : "Remove from schedule"}
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>
          {editable ? "Cancel" : "Close"}
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
        {editable && (
          <button
            className="btn"
            disabled={!dirty || busy || whenError !== null}
            title={whenError ?? undefined}
            onClick={() => void save()}
          >
            <svg>
              <use href="#i-check" />
            </svg>{" "}
            {busy && !confirmDelete ? "Saving…" : "Save time"}
          </button>
        )}
      </div>
    </Modal>
  );
}
