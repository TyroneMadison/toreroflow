import { useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import { api, fileUrl, type PostTargetInfo } from "../lib/api";
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
            ) : (
              target.error && <div className="autherr">{target.error}</div>
            )}
          </div>
        </div>

        {studioUrl && (
          <div className="pdstudio">
            <div className="what">
              YouTube's Related video pin has no API, on any tool. If this Short should point at
              another video, set it here.
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
