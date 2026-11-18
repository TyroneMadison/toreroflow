import { useCallback, useEffect, useState } from "react";
import { api, API_URL } from "../lib/api";
import { useIsPhone } from "../lib/phone";
import { useToast } from "../components/Toasts";
import Modal from "../modals/Modal";
import { useEditor } from "./StudioEditor";
import { setCommentMarkers, type CommentMarker } from "./commentStore";
import { PhoneMenu, useLongPress } from "./phoneBits";

/**
 * Phase 8 (mock-up 23): timestamped comments with replies and resolve, a
 * signed read-only review link for the client, and NLE / caption exports.
 */

export interface CommentRow {
  id: string;
  parentId: string | null;
  atSec: number | null;
  body: string;
  authorName: string;
  authorKind: string;
  resolvedAt: string | null;
  createdAt: string;
}
export interface CommentThread extends CommentRow {
  replies: CommentRow[];
}
interface CommentsResponse {
  threads: CommentThread[];
  open: number;
  markers: CommentMarker[];
}
interface ReviewLinkRow {
  id: string;
  url: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const fmtAt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const appOrigin = () => (window.location.protocol.startsWith("http") ? window.location.origin : API_URL);

/** Loads the comments once the editor opens, so markers show without the panel. */
export function useCommentsLoader(projectId: string) {
  useEffect(() => {
    let gone = false;
    api.get<CommentsResponse>(`/edit-projects/${projectId}/comments`).then(
      (r) => !gone && setCommentMarkers(r.markers),
      () => undefined,
    );
    return () => {
      gone = true;
      setCommentMarkers([]);
    };
  }, [projectId]);
}

type Tab = "comments" | "share" | "export";

export default function CollabPanel({ initial = "comments", onClose }: { initial?: Tab; onClose: () => void }) {
  const { project, outputTime, seek } = useEditor();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(initial);
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [body, setBody] = useState("");
  const [pin, setPin] = useState(true);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [links, setLinks] = useState<ReviewLinkRow[] | null>(null);
  const [hours, setHours] = useState(24 * 7);
  // Phone: which thread's reply box is open, and a comment's long-press menu (Delete).
  const isPhone = useIsPhone();
  const [replyOpen, setReplyOpen] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<CommentRow | null>(null);
  const press = useLongPress<CommentRow>(setMenuFor);

  const load = useCallback(async () => {
    try {
      const r = await api.get<CommentsResponse>(`/edit-projects/${project.id}/comments`);
      setData(r);
      setCommentMarkers(r.markers);
    } catch (e) {
      toast.fail("Loading comments", e);
    }
  }, [project.id, toast]);
  const loadLinks = useCallback(async () => {
    try {
      setLinks((await api.get<{ links: ReviewLinkRow[] }>(`/edit-projects/${project.id}/review-links`)).links);
    } catch (e) {
      toast.fail("Loading review links", e);
    }
  }, [project.id, toast]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (tab === "share") void loadLinks();
  }, [tab, loadLinks]);

  async function add(parentId?: string) {
    const text = (parentId ? reply[parentId] : body)?.trim();
    if (!text) return;
    try {
      await api.post(`/edit-projects/${project.id}/comments`, parentId ? { body: text, parentId } : { body: text, atSec: pin ? Math.round(outputTime * 10) / 10 : null });
      if (parentId) setReply((r) => ({ ...r, [parentId]: "" }));
      else setBody("");
      await load();
    } catch (e) {
      toast.fail("Posting the comment", e);
    }
  }
  async function resolve(c: CommentRow, on: boolean) {
    try {
      await api.patch(`/edit-comments/${c.id}`, { resolved: on });
      await load();
    } catch (e) {
      toast.fail("Updating the comment", e);
    }
  }
  async function remove(c: CommentRow) {
    try {
      await api.del(`/edit-comments/${c.id}`);
      await load();
    } catch (e) {
      toast.fail("Deleting the comment", e);
    }
  }
  async function makeLink() {
    try {
      const l = await api.post<ReviewLinkRow>(`/edit-projects/${project.id}/review-links`, { expiresInHours: hours });
      await navigator.clipboard?.writeText(appOrigin() + l.url).catch(() => undefined);
      toast.success("Review link made and copied. It is read-only; the client can comment.");
      await loadLinks();
    } catch (e) {
      toast.fail("Making the review link", e);
    }
  }
  async function revoke(l: ReviewLinkRow) {
    try {
      await api.del(`/review-links/${l.id}`);
      await loadLinks();
    } catch (e) {
      toast.fail("Turning the link off", e);
    }
  }
  async function download(kind: "premiere" | "fcpxml" | "srt" | "txt") {
    try {
      const r =
        kind === "premiere" || kind === "fcpxml"
          ? await api.get<{ fileName: string; text: string }>(`/edit-projects/${project.id}/export-xml?format=${kind}&json=1`)
          : await api.get<{ fileName: string; text: string }>(`/edit-projects/${project.id}/transcript?format=${kind}&json=1`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([r.text], { type: "text/plain" }));
      a.download = r.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      toast.fail("Exporting", e);
    }
  }

  const threads = (data?.threads ?? []).filter((t) => showResolved || !t.resolvedAt);

  if (isPhone) {
    // Phone sheet: one segmented control, threads that read like a chat with
    // 44 px Reply and Resolve, Delete on long-press, and the composer pinned
    // to the bottom with the playhead time as a chip.
    const when = (iso: string) => {
      const d = new Date(iso);
      return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
    };
    const share = async (l: ReviewLinkRow) => {
      const url = appOrigin() + l.url;
      if (navigator.share) {
        try {
          await navigator.share({ title: `Review: ${project.name}`, url });
        } catch {
          // Closing the share sheet is not an error.
        }
      } else {
        await navigator.clipboard?.writeText(url).catch(() => undefined);
        toast.success("Review link copied.");
      }
    };
    const client = <span className="mb-pill info nodot">Client</span>;
    return (
      <>
        <Modal maxWidth={560} onClose={onClose} label="Review">
          <div className="modal-head">
            <h3>Review</h3>
            <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
              <svg>
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          <div className="modal-body mb-collab">
            <div className="seg mb-lg" role="tablist" aria-label="Review">
              {(["comments", "share", "export"] as Tab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                  {t === "comments" ? `Comments${data ? ` ${data.open}` : ""}` : t === "share" ? "Review link" : "Export"}
                </button>
              ))}
            </div>

            {tab === "comments" && (
              <>
                <div className="mb-fhead">
                  <span className="mb-lab">{data?.open ?? 0} open</span>
                  <button type="button" className="mb-btn text" onClick={() => setShowResolved(!showResolved)}>
                    {showResolved ? "Hide resolved" : "Show resolved"}
                  </button>
                </div>
                {data && threads.length === 0 && <p className="mb-p muted">No open comments.</p>}
                {threads.map((t) => (
                  <div key={t.id} className={`mb-cth${t.resolvedAt ? " done" : ""}`} {...press(t)}>
                    <div className="mb-thd">
                      {t.atSec != null && (
                        <button type="button" className="mb-cts" aria-label={`Jump to ${fmtAt(t.atSec)}`} onClick={() => seek(t.atSec!)}>
                          {fmtAt(t.atSec)}
                        </button>
                      )}
                      <b>{t.authorName}</b>
                      {t.authorKind === "client" && client}
                      <small>{when(t.createdAt)}</small>
                    </div>
                    <p>{t.body}</p>
                    {t.replies.map((r) => (
                      <div key={r.id} className="mb-creply" {...press(r)}>
                        <b>{r.authorName}</b>
                        {r.authorKind === "client" && client} {r.body}
                      </div>
                    ))}
                    {replyOpen === t.id && (
                      <div className="mb-inrow">
                        <input
                          className="mb-input"
                          aria-label="Reply"
                          placeholder="Reply"
                          enterKeyHint="send"
                          value={reply[t.id] ?? ""}
                          onChange={(e) => setReply((m) => ({ ...m, [t.id]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && void add(t.id)}
                        />
                        <button type="button" className="mb-btn pri" disabled={!reply[t.id]?.trim()} onClick={() => void add(t.id)}>
                          Send
                        </button>
                      </div>
                    )}
                    <div className="mb-thacts">
                      <button type="button" className="mb-btn sm ghost" onClick={() => setReplyOpen(replyOpen === t.id ? null : t.id)}>
                        Reply
                      </button>
                      <button type="button" className="mb-btn sm" onClick={() => void resolve(t, !t.resolvedAt)}>
                        {!t.resolvedAt && (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <use href="#i-check" />
                          </svg>
                        )}
                        {t.resolvedAt ? "Reopen" : "Resolve"}
                      </button>
                    </div>
                  </div>
                ))}
                <p className="mb-note">Tap a timestamp to jump the preview there. Long-press a comment to delete it.</p>
              </>
            )}

            {tab === "share" && (
              <>
                <p className="mb-p muted">
                  A read-only page with the last render and the comments. The client can watch and comment, nothing else. Render first so they have something to watch.
                </p>
                <div className="mb-field">
                  <label htmlFor="rl-hours">The link lasts</label>
                  <select id="rl-hours" className="mb-input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                    <option value={24}>1 day</option>
                    <option value={24 * 7}>7 days</option>
                    <option value={24 * 30}>30 days</option>
                  </select>
                </div>
                <button type="button" className="mb-btn pri block" onClick={() => void makeLink()}>
                  New review link
                </button>
                {links?.length === 0 && <p className="mb-p muted">No review links yet.</p>}
                {links && links.length > 0 && (
                  <div className="mb-card list">
                    {links.map((l) => {
                      const dead = !!l.revokedAt || new Date(l.expiresAt) <= new Date();
                      return (
                        <div key={l.id} className={`mb-lrow mb-rl${dead ? " dead" : ""}`}>
                          <span className="mb-lt">
                            <b>{(appOrigin() + l.url).replace(/^https?:\/\//, "")}</b>
                            <small>{l.revokedAt ? "Off" : dead ? "Expired" : `Until ${new Date(l.expiresAt).toLocaleDateString()}`}</small>
                          </span>
                          {!dead && (
                            <>
                              <button type="button" className="mb-ib" aria-label="Share the link" onClick={() => void share(l)}>
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <use href="#i-share" />
                                </svg>
                              </button>
                              <button type="button" className="mb-btn sm text" onClick={() => void revoke(l)}>
                                Turn off
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {tab === "export" && (
              <>
                <p className="mb-p muted">The cut as a timeline for Premiere or Final Cut (relink to your source files), or the captions.</p>
                <div className="mb-card list">
                  {(
                    [
                      ["premiere", "Premiere XML", "A timeline for Premiere Pro"],
                      ["fcpxml", "Final Cut FCPXML", "A timeline for Final Cut Pro"],
                      ["srt", "SRT", "The captions with their timings"],
                      ["txt", "TXT", "The transcript as plain text"],
                    ] as const
                  ).map(([k, label, sub]) => (
                    <button key={k} type="button" className="mb-lrow" onClick={() => void download(k)}>
                      <span className="mb-lic n">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <use href="#i-dl" />
                        </svg>
                      </span>
                      <span className="mb-lt">
                        <b>{label}</b>
                        <small>{sub}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {tab === "comments" && (
            <div className="modal-foot mb-cfoot">
              <div className="mb-pinrow">
                <button type="button" className={`mb-chip${pin ? " on" : " out"}`} aria-pressed={pin} onClick={() => setPin(!pin)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-clock" />
                  </svg>
                  at {fmtAt(outputTime)}
                </button>
                <small>{pin ? "Pinned to the playhead" : "Not pinned to a time"}</small>
              </div>
              <div className="mb-inrow">
                <textarea
                  className="mb-input"
                  aria-label="Comment"
                  rows={1}
                  maxLength={2000}
                  placeholder="Leave a note for the team or client"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <button type="button" className="mb-ib mb-csend" aria-label="Comment" disabled={!body.trim()} onClick={() => void add()}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-send" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </Modal>
        {menuFor && (
          <PhoneMenu
            title={`${menuFor.authorName}: ${menuFor.body}`}
            onClose={() => setMenuFor(null)}
            items={[{ label: "Delete comment", danger: true, run: () => void remove(menuFor) }]}
          />
        )}
      </>
    );
  }

  return (
    <Modal maxWidth={560} onClose={onClose} label="Review">
      <div className="collab">
        <div className="pnl-pills">
          {(["comments", "share", "export"] as Tab[]).map((t) => (
            <button key={t} className={`pnl-pill${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {t === "comments" ? `Comments${data ? ` · ${data.open}` : ""}` : t === "share" ? "Review link" : "Export"}
            </button>
          ))}
        </div>

        {tab === "comments" && (
          <>
            <div className="collab-new">
              <textarea className="field-in" rows={2} maxLength={2000} placeholder="Leave a note for the team or client" value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="collab-row">
                <label className="mini">
                  <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> at {fmtAt(outputTime)}
                </label>
                <label className="mini">
                  <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> show resolved
                </label>
                <button className="btn sm" disabled={!body.trim()} onClick={() => void add()}>Comment</button>
              </div>
            </div>
            <div className="collab-list">
              {data && threads.length === 0 && <div className="empty">No open comments.</div>}
              {threads.map((t) => (
                <div key={t.id} className={`collab-thread${t.resolvedAt ? " done" : ""}`}>
                  <div className="collab-head">
                    {t.atSec != null && (
                      <button className="collab-at" title="Jump there" onClick={() => seek(t.atSec!)}>{fmtAt(t.atSec)}</button>
                    )}
                    <b>{t.authorName}</b>
                    {t.authorKind === "client" && <span className="collab-tag">client</span>}
                    <span className="sub">{new Date(t.createdAt).toLocaleString()}</span>
                  </div>
                  <p>{t.body}</p>
                  {t.replies.map((r) => (
                    <div key={r.id} className="collab-reply">
                      <b>{r.authorName}</b>{r.authorKind === "client" && <span className="collab-tag">client</span>} {r.body}
                      <button className="linkbtn" onClick={() => void remove(r)}>Delete</button>
                    </div>
                  ))}
                  <div className="collab-row">
                    <input className="field-in" placeholder="Reply" value={reply[t.id] ?? ""} onChange={(e) => setReply((m) => ({ ...m, [t.id]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && void add(t.id)} />
                    <button className="btn sm ghost" onClick={() => void resolve(t, !t.resolvedAt)}>{t.resolvedAt ? "Reopen" : "Resolve"}</button>
                    <button className="linkbtn" onClick={() => void remove(t)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "share" && (
          <>
            <p className="sub">
              A read-only page with the last render and the comments. The client can watch and comment, nothing else. Render first so they have something to watch.
            </p>
            <div className="collab-row">
              <select className="field-in" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                <option value={24}>1 day</option>
                <option value={24 * 7}>7 days</option>
                <option value={24 * 30}>30 days</option>
              </select>
              <button className="btn sm" onClick={() => void makeLink()}>New review link</button>
            </div>
            <div className="collab-list">
              {links?.length === 0 && <div className="empty">No review links yet.</div>}
              {links?.map((l) => {
                const dead = !!l.revokedAt || new Date(l.expiresAt) <= new Date();
                return (
                  <div key={l.id} className={`collab-link${dead ? " done" : ""}`}>
                    <code>{appOrigin() + l.url.slice(0, 18)}…</code>
                    <span className="sub">{l.revokedAt ? "off" : dead ? "expired" : `until ${new Date(l.expiresAt).toLocaleDateString()}`}</span>
                    {!dead && (
                      <>
                        <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(appOrigin() + l.url)}>Copy</button>
                        <button className="linkbtn" onClick={() => void revoke(l)}>Turn off</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === "export" && (
          <>
            <p className="sub">The cut as a timeline for Premiere or Final Cut (relink to your source files), or the captions.</p>
            <div className="collab-row">
              <button className="btn sm" onClick={() => void download("premiere")}>Premiere XML</button>
              <button className="btn sm" onClick={() => void download("fcpxml")}>Final Cut FCPXML</button>
              <button className="btn sm ghost" onClick={() => void download("srt")}>SRT</button>
              <button className="btn sm ghost" onClick={() => void download("txt")}>TXT</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
