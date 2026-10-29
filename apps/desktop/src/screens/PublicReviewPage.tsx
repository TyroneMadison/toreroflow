import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Loading } from "../components/states";
import { Note } from "../components/ideas/IdeaBits";
import { PublicShell } from "./IdeaScreens";
import type { CommentThread } from "../editor/CollabPanel";
import { fmtAt } from "../editor/CollabPanel";
import type { CommentMarker } from "../editor/commentStore";
import "../editor/StudioEditor.css";

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
  const path = `/v/${encodeURIComponent(token)}`;

  const load = useCallback(
    () =>
      api.get<ReviewData>(path).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "This link could not be opened.")),
    [path],
  );
  useEffect(() => void load(), [load]);

  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
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
