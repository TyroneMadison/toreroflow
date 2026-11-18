import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Loading } from "../components/states";
import { Note } from "../components/ideas/IdeaBits";
import { PublicShell } from "./IdeaScreens";
import type { CommentThread } from "../editor/CollabPanel";
import { fmtAt } from "../editor/CollabPanel";
import type { CommentMarker } from "../editor/commentStore";
import "../editor/StudioEditor.css";
import { useIsPhone } from "../lib/phone";
import ThumbPlayer, { mmss, type ThumbPlayerHandle } from "../components/mobile/ThumbPlayer";

interface ReviewData {
  name: string;
  expiresAt: string;
  video: { url: string } | null;
  threads: CommentThread[];
  open: number;
  markers: CommentMarker[];
}

const NAME_KEY = "tf.reviewName";

/**
 * /v/:token, Phase 8: the client watches the last render and leaves
 * timestamped comments or replies. Read-only otherwise: no edit, resolve,
 * delete or download controls.
 */
export default function PublicReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [body, setBody] = useState("");
  const [pin, setPin] = useState(true);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<ThumbPlayerHandle>(null);
  const isPhone = useIsPhone();
  const [editName, setEditName] = useState(false);
  const path = `/v/${encodeURIComponent(token)}`;

  const load = useCallback(
    () =>
      api.get<ReviewData>(path).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "This link could not be opened.")),
    [path],
  );
  useEffect(() => void load(), [load]);

  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
    player.current?.seek(t);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    setBusy(true);
    try {
      localStorage.setItem(NAME_KEY, name.trim());
      await api.post(`${path}/comments`, {
        name: name.trim(),
        body: body.trim(),
        ...(replyTo ? { parentId: replyTo } : pin ? { atSec: Math.round(time * 10) / 10 } : {}),
      });
      setBody("");
      setReplyTo(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your comment did not send.");
    } finally {
      setBusy(false);
    }
  }

  if (isPhone) {
    // Phone (mobile pass): video first with note dots, notes read like a chat
    // (resolved ones dimmed at the bottom), and a messaging-style composer
    // stuck to the bottom: the remembered name, an "at 0:01" chip that follows
    // the playhead, and a 48px Send.
    const threads = data ? [...data.threads].sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt)) : [];
    const resolved = threads.filter((t) => t.resolvedAt).length;
    const replying = replyTo ? data?.threads.find((t) => t.id === replyTo) : null;
    return (
      <PublicShell
        title={data ? `Review: ${data.name}` : "Review an edit"}
        phoneTitle={data?.name}
        sub={data ? "Leave notes at the exact second. Torerone sees them right away." : undefined}
        context="Review an edit"
      >
        {error && <Note tone="bad">{error}</Note>}
        {!data && !error && <Loading screen="review" />}
        {data && (
          <div className="mb-review">
            {data.video ? (
              <ThumbPlayer
                ref={player}
                src={data.video.url}
                label={`Video, ${data.name}`}
                markers={data.markers.map((m) => ({ at: m.at, done: m.resolved }))}
                onTime={setTime}
                onDuration={setDuration}
              />
            ) : (
              <Note tone="warn">The video is not rendered yet. You can still read and leave notes.</Note>
            )}
            <div className="mb-cardh flat">
              <span className="mb-lab">
                {threads.length} {threads.length === 1 ? "note" : "notes"}
                {resolved ? `, ${resolved} resolved` : ""}
              </span>
              {duration > 0 && threads.length > 0 && <small>Tap a time to jump there</small>}
            </div>
            <div className="mb-notes">
              {threads.length === 0 && <p className="mb-p muted">No notes yet. Pause on a moment and write what should change.</p>}
              {threads.map((t) => (
                <div key={t.id} className={`mb-th${t.resolvedAt ? " res" : ""}`}>
                  <div className="mb-thh">
                    {t.atSec != null && (
                      <button type="button" className="mb-ts" onClick={() => seek(t.atSec!)}>
                        {mmss(t.atSec)}
                      </button>
                    )}
                    <b>{t.authorName}</b>
                    {t.resolvedAt && <span className="mb-pill nodot">Resolved</span>}
                  </div>
                  <p>{t.body}</p>
                  {t.replies.map((r) => (
                    <div key={r.id} className="mb-reply">
                      <b>{r.authorName}</b> {r.body}
                    </div>
                  ))}
                  {!t.resolvedAt && (
                    <button type="button" className="mb-btn text sm mb-replybtn" onClick={() => setReplyTo(t.id)}>
                      Reply
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="mb-p muted small mb-center">This link expires {new Date(data.expiresAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</p>
            <form className="mb-composer" onSubmit={submit}>
              {(editName || !name.trim()) && (
                <input className="mb-input" placeholder="Your name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && setEditName(false)} autoComplete="name" />
              )}
              <div className="mb-chiprow">
                {name.trim() && !editName && (
                  <button type="button" className="mb-chip" onClick={() => setEditName(true)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-user" />
                    </svg>
                    {name}
                  </button>
                )}
                {replying ? (
                  <button type="button" className="mb-chip on" onClick={() => setReplyTo(null)}>
                    Replying to {replying.authorName}, cancel
                  </button>
                ) : (
                  <button type="button" className={`mb-chip${pin ? " on" : ""}`} aria-pressed={pin} onClick={() => setPin((p) => !p)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-clock" />
                    </svg>
                    {pin ? `at ${mmss(time)}` : "No time"}
                  </button>
                )}
              </div>
              <div className="mb-sendrow">
                <textarea className="mb-input" rows={1} maxLength={2000} placeholder={replyTo ? "Your reply" : "What should change here?"} value={body} onChange={(e) => setBody(e.target.value)} />
                <button className="mb-send" aria-label={replyTo ? "Send reply" : "Send note"} disabled={busy || !name.trim() || !body.trim()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-send" />
                  </svg>
                </button>
              </div>
            </form>
          </div>
        )}
      </PublicShell>
    );
  }

  return (
    <PublicShell title={data ? `Review: ${data.name}` : "Review an edit"}>
      {error && <Note tone="bad">{error}</Note>}
      {!data && !error && <Loading screen="review" />}
      {data && (
        <div className="collab review-page">
          {data.video ? (
            <div className="review-video">
              <video
                ref={video}
                src={data.video.url}
                controls
                playsInline
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
              />
              {duration > 0 && (
                <div className="review-markers">
                  {data.markers.map((m) => (
                    <button key={m.id} className={`tl-cmark${m.resolved ? " done" : ""}`} style={{ left: `${(m.at / duration) * 100}%` }} onClick={() => seek(m.at)}>
                      {m.count > 1 ? m.count : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Note tone="warn">The video is not rendered yet. You can still read and leave notes.</Note>
          )}
          <form className="collab-new" onSubmit={submit}>
            <div className="collab-row">
              <input className="field-in" placeholder="Your name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              {replyTo ? (
                <button type="button" className="linkbtn" onClick={() => setReplyTo(null)}>Replying, cancel</button>
              ) : (
                <label className="mini">
                  <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> at {fmtAt(time)}
                </label>
              )}
            </div>
            <textarea className="field-in" rows={2} maxLength={2000} placeholder={replyTo ? "Your reply" : "What should change here?"} value={body} onChange={(e) => setBody(e.target.value)} />
            <button className="btn sm" disabled={busy || !name.trim() || !body.trim()}>{busy ? "Sending..." : replyTo ? "Reply" : "Comment"}</button>
          </form>
          <div className="collab-list">
            {data.threads.length === 0 && <div className="empty">No comments yet.</div>}
            {data.threads.map((t) => (
              <div key={t.id} className={`collab-thread${t.resolvedAt ? " done" : ""}`}>
                <div className="collab-head">
                  {t.atSec != null && <button className="collab-at" onClick={() => seek(t.atSec!)}>{fmtAt(t.atSec)}</button>}
                  <b>{t.authorName}</b>
                  {t.resolvedAt && <span className="collab-tag">resolved</span>}
                </div>
                <p>{t.body}</p>
                {t.replies.map((r) => (
                  <div key={r.id} className="collab-reply">
                    <b>{r.authorName}</b> {r.body}
                  </div>
                ))}
                {!t.resolvedAt && <button className="linkbtn" onClick={() => setReplyTo(t.id)}>Reply</button>}
              </div>
            ))}
          </div>
          <p className="id-note">This link expires {new Date(data.expiresAt).toLocaleString()}.</p>
        </div>
      )}
    </PublicShell>
  );
}
