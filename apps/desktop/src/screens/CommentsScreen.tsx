import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { Seg } from "../components/PostDetails";
import { Empty, ErrorState, Loading } from "../components/states";
import Pf from "../components/Pf";
import SwipeRow from "../components/mobile/SwipeRow";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { Ic, PhoneHead, usePullToRefresh } from "../components/analytics/phoneBits";
import { brandColor } from "../lib/avatar";
import { useIsPhone } from "../lib/phone";

/**
 * Comments inbox (mockup ig-08): comments on this brand's published
 * Instagram and TikTok posts, through Zernio. Read, reply, hide, delete.
 * Reading is open to bots; the server decides who may moderate and says so
 * (canModerate), and the buttons follow it.
 */

interface CommentedPost {
  id: string;
  platform: string;
  accountId: string;
  accountUsername: string | null;
  content: string | null;
  permalink: string | null;
  createdTime: string | null;
  commentCount: number;
}

interface PostComment {
  id: string;
  message: string;
  createdTime: string | null;
  username: string | null;
  name: string | null;
  isOwner: boolean;
  canReply: boolean;
  canDelete: boolean;
  canHide: boolean;
  isHidden: boolean;
  replies: PostComment[];
}

type Filter = "all" | "instagram" | "tiktok";

export default function CommentsScreen() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [posts, setPosts] = useState<CommentedPost[] | null>(null);
  const [canModerate, setCanModerate] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedClient) return;
    setError(null);
    try {
      const q = filter === "all" ? "" : `?platform=${filter}`;
      const r = await api.get<{ posts: CommentedPost[]; canModerate: boolean; configured: boolean }>(
        `/clients/${selectedClient.id}/comments${q}`,
      );
      setPosts(r.posts);
      setCanModerate(r.canModerate);
      setConfigured(r.configured);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load comments");
    }
  }, [selectedClient, filter]);

  useEffect(() => {
    setPosts(null);
    void load();
  }, [load]);

  const state = !selectedClient ? "empty" : error && !posts ? "error" : posts ? "ready" : "loading";
  const isPhone = useIsPhone();
  const [pulling, setPulling] = useState(false);
  // Phone: pull down to refresh replaces the Refresh button.
  const ptr = usePullToRefresh(
    () => {
      setPulling(true);
      void load().finally(() => setPulling(false));
    },
    pulling,
    isPhone,
  );

  // Phone (mobile pass, mockup "comments"): a segmented control with the
  // count, posts that fold with how many comments still need a reply, and
  // chat-style threads (see PostThread).
  if (isPhone) {
    const total = posts?.reduce((s, p) => s + p.commentCount, 0) ?? 0;
    return (
      <section className="screen active mb-page rp-page" data-screen="comments" data-state={state}>
        <PhoneHead screen="comments" sub="Instagram and TikTok comments in one place. Refreshes about every 10 minutes." />
        {ptr}
        {state === "empty" && <Empty screen="comments" title="No brand selected" hint="Pick a brand with the switcher at the top." />}
        {state === "error" && <ErrorState screen="comments" message={error} onRetry={() => void load()} />}
        {state === "ready" && !canModerate && (
          <div className="mb-banner warn rp-okb" role="note">
            <Ic name="i-lock" />
            <span className="mb-bt">This bot can read comments. Reply, hide and delete need the operator.</span>
          </div>
        )}
        {(state === "ready" || state === "loading") && (
          <div className="seg rp-seglg" role="tablist" aria-label="Platform" data-testid="comments-filter">
            {(["all", "instagram", "tiktok"] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "on" : undefined} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "instagram" ? "Instagram" : "TikTok"}
                {filter === f && posts ? ` · ${total}` : ""}
              </button>
            ))}
          </div>
        )}
        {state === "loading" && <Loading screen="comments" label="Loading comments" />}
        {state === "ready" &&
          (!configured ? (
            <div className="mb-card rp-none">
              <b>Nothing connected through Zernio yet</b>
              <p>Comments show here once this brand has accounts connected through Zernio.</p>
            </div>
          ) : posts!.length === 0 ? (
            <div className="mb-empty">
              <span className="mb-ei">
                <Ic name="i-comment" />
              </span>
              <h3>No comments yet</h3>
              <p>No comments on recent {selectedClient!.name} posts.</p>
            </div>
          ) : (
            posts!.map((p) => (
              <PostThread
                key={p.id}
                post={p}
                clientId={selectedClient!.id}
                open={open === p.id}
                onToggle={() => setOpen(open === p.id ? null : p.id)}
                canModerate={canModerate}
                toast={toast}
              />
            ))
          ))}
        {state === "ready" && <p className="rp-note rp-center">TikTok comments show for accounts connected through TikTok for Business.</p>}
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="comments" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Comments inbox</h2>
          <p>Instagram and TikTok comments in one place.</p>
        </div>
      </div>
      <div className="stage">
        {state === "empty" && <Empty screen="comments" title="No brand selected" hint="Pick a brand in the dock." />}
        {state === "error" && <ErrorState screen="comments" message={error} onRetry={() => void load()} />}
        {state === "loading" && <Loading screen="comments" label="Loading comments" />}
        {state === "ready" && (
          <>
            {!canModerate && (
              <div className="lfnote warn cm-banner" role="note">
                This bot can read comments. Reply, hide and delete need the operator.
              </div>
            )}
            <div className="cm-bar">
              <Seg
                label="Platform"
                value={filter}
                onChange={setFilter}
                testId="comments-filter"
                options={[
                  { id: "all", label: "All" },
                  { id: "instagram", label: "Instagram" },
                  { id: "tiktok", label: "TikTok" },
                ]}
              />
              <button type="button" className="btn ghost cm-btn" onClick={() => void load()}>
                Refresh
              </button>
            </div>
            <p className="lnote">
              Zernio refreshes comments about every 10 minutes. TikTok comments show for accounts connected through
              the TikTok for Business app.
            </p>
            {!configured ? (
              <p className="insworking">This brand has no accounts connected through Zernio yet.</p>
            ) : posts!.length === 0 ? (
              <p className="insworking">No comments on recent posts.</p>
            ) : (
              posts!.map((p) => (
                <PostThread
                  key={p.id}
                  post={p}
                  clientId={selectedClient!.id}
                  open={open === p.id}
                  onToggle={() => setOpen(open === p.id ? null : p.id)}
                  canModerate={canModerate}
                  toast={toast}
                />
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PostThread({
  post,
  clientId,
  open,
  onToggle,
  canModerate,
  toast,
}: {
  post: CommentedPost;
  clientId: string;
  open: boolean;
  onToggle(): void;
  canModerate: boolean;
  toast: ReturnType<typeof useToast>;
}) {
  const [comments, setComments] = useState<PostComment[] | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const isPhone = useIsPhone();
  /** Phone: the comment a swipe, long-press or the trash button asked to delete. */
  const [ask, setAsk] = useState<PostComment | null>(null);
  /** Bumped when the delete sheet closes, so a swiped-away row comes back. */
  const [nonce, setNonce] = useState(0);
  const base = `/clients/${clientId}/comments/${encodeURIComponent(post.id)}`;

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ comments: PostComment[] }>(`${base}?accountId=${encodeURIComponent(post.accountId)}`);
      setComments(r.comments);
    } catch (err) {
      setComments([]);
      toast.fail("Could not load the comments", err);
    }
  }, [base, post.accountId, toast]);

  useEffect(() => {
    if (open && comments === null) void load();
  }, [open, comments, load]);

  const act = async (id: string, run: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await run();
      toast.success(done);
      await load();
    } catch (err) {
      toast.fail("That didn't go through", err);
    } finally {
      setBusy(null);
    }
  };

  const title = (post.content ?? "").split("\n")[0]!.slice(0, 80) || "Untitled post";
  const who = (c: PostComment) => c.username ?? c.name ?? "someone";
  const hide = (c: PostComment) =>
    void act(
      c.id,
      () => api.post(`${base}/${encodeURIComponent(c.id)}/hide`, { accountId: post.accountId, hidden: !c.isHidden }),
      c.isHidden ? "Comment shown again." : "Comment hidden.",
    );
  const remove = (c: PostComment) =>
    void act(c.id, () => api.del(`${base}/${encodeURIComponent(c.id)}?accountId=${encodeURIComponent(post.accountId)}`), "Comment deleted.");
  const send = (c: PostComment) =>
    void act(c.id, () => api.post(`${base}/reply`, { accountId: post.accountId, message: reply.trim(), commentId: c.id }), "Reply posted.").then(() => {
      setReply("");
      setReplyTo(null);
    });

  // Phone: a folding card per post with how many comments still need a reply
  // (once its thread has loaded), chat-style comments, a coral Reply where
  // nobody from the brand has answered, and Delete behind a swipe left, a
  // long-press or the trash button, always with a confirm.
  if (isPhone) {
    const answered = (c: PostComment) => c.replies.some((r) => r.isOwner);
    const unanswered = comments?.filter((c) => !c.isOwner && !c.isHidden && !answered(c)).length ?? 0;
    const closeAsk = () => {
      setAsk(null);
      setNonce((n) => n + 1);
    };
    return (
      <section className="rp-pg" data-testid={`comments-post-${post.id}`}>
        <button type="button" className="rp-pghd" aria-expanded={open} onClick={onToggle}>
          <span className="rp-pgthumb">
            <Pf p={post.platform === "tiktok" ? "tt" : "ig"} size="sm" />
          </span>
          <span className="rp-grow">
            <b>{title}</b>
            <small>
              {post.platform === "tiktok" ? "TikTok" : "Instagram"} · {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
              {unanswered > 0 && <span className="rp-unans"> · {unanswered} unanswered</span>}
            </small>
          </span>
          <Ic name={open ? "i-chev-u" : "i-chev"} />
        </button>
        {open && (
          <div className="rp-cms">
            {comments === null && <p className="rp-empty rp-cmpad">Loading</p>}
            {comments?.length === 0 && <p className="rp-empty rp-cmpad">No comments to show.</p>}
            {comments?.map((c, i) => {
              const del = c.canDelete && canModerate ? () => setAsk(c) : undefined;
              const name = who(c);
              return (
                <SwipeRow key={`${c.id}:${nonce}`} className={`rp-cm${c.isHidden ? " hid" : ""}`} onLeft={del} onLong={del}>
                  <span className="rp-av" aria-hidden="true" style={{ background: `linear-gradient(160deg,${brandColor(i + name.length)},rgba(0,0,0,.35))` }}>
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="rp-cmt">
                    <b>
                      @{name}
                      {c.isHidden && <span className="mb-pill nodot">Hidden</span>}
                    </b>
                    <p>{c.message}</p>
                    {c.replies.map((r) => (
                      <div className="rp-rep" key={r.id}>
                        <b>@{r.username ?? r.name ?? "reply"}</b> {r.message}
                      </div>
                    ))}
                    {replyTo === c.id && (
                      <form
                        className="rp-compose"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (reply.trim()) send(c);
                        }}
                      >
                        <small>Replying to @{name}</small>
                        <div className="mb-inrow">
                          <input
                            className="mb-input"
                            aria-label={`Reply to @${name}`}
                            value={reply}
                            maxLength={2200}
                            autoFocus
                            enterKeyHint="send"
                            onChange={(e) => setReply(e.target.value)}
                          />
                          <button className="mb-btn pri" disabled={!reply.trim() || busy === c.id}>
                            Send
                          </button>
                        </div>
                      </form>
                    )}
                    {(c.canReply || c.canHide || c.canDelete) && (
                      <span className="rp-cmacts">
                        {c.canReply && (
                          <button
                            type="button"
                            className={`mb-btn sm${answered(c) || c.isOwner || c.isHidden ? "" : " pri"}`}
                            disabled={!canModerate || busy === c.id}
                            onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}
                          >
                            Reply
                          </button>
                        )}
                        {c.canHide && (
                          <button type="button" className="mb-btn sm ghost" disabled={!canModerate || busy === c.id} onClick={() => hide(c)}>
                            {c.isHidden ? "Unhide" : "Hide"}
                          </button>
                        )}
                        {c.canDelete && (
                          <button
                            type="button"
                            className="mb-ib ghost rp-del"
                            aria-label={`Delete the comment from @${name}`}
                            disabled={!canModerate || busy === c.id}
                            onClick={() => setAsk(c)}
                          >
                            <Ic name="i-trash" />
                          </button>
                        )}
                        {!canModerate && <small className="rp-need">Needs the operator</small>}
                      </span>
                    )}
                  </span>
                </SwipeRow>
              );
            })}
          </div>
        )}
        {ask && (
          <ConfirmSheet
            title="Delete this comment?"
            body={`@${who(ask)}: "${ask.message.length > 120 ? `${ask.message.slice(0, 117)}...` : ask.message}" It comes off the post for good.`}
            confirm="Delete"
            danger
            busy={busy === ask.id}
            onClose={closeAsk}
            onConfirm={() => {
              const c = ask;
              closeAsk();
              remove(c);
            }}
          />
        )}
      </section>
    );
  }

  return (
    <div className="card glass cm-post" data-testid={`comments-post-${post.id}`}>
      <button type="button" className="cm-head" aria-expanded={open} onClick={onToggle}>
        <span className="cm-title">
          {title}
          <span className="cm-plat">{post.platform === "tiktok" ? "TikTok" : "Instagram"}</span>
        </span>
        <span className="cm-count">
          {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="cm-list">
          {comments === null && <p className="lnote">Loading…</p>}
          {comments?.length === 0 && <p className="lnote">No comments to show.</p>}
          {comments?.map((c) => (
            <div className={`cm-row${c.isHidden ? " hidden" : ""}`} key={c.id}>
              <span className="cm-avatar" aria-hidden="true">
                {(c.username ?? c.name ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <div className="cm-body">
                <b>@{c.username ?? c.name ?? "someone"}</b>
                {c.isHidden && <span className="cm-flag">hidden</span>}
                <p>{c.message}</p>
                {c.replies.map((r) => (
                  <p className="cm-reply" key={r.id}>
                    <b>@{r.username ?? r.name ?? "reply"}</b> {r.message}
                  </p>
                ))}
                {replyTo === c.id && (
                  <form
                    className="cm-replyform"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!reply.trim()) return;
                      void act(
                        c.id,
                        () => api.post(`${base}/reply`, { accountId: post.accountId, message: reply.trim(), commentId: c.id }),
                        "Reply posted.",
                      ).then(() => {
                        setReply("");
                        setReplyTo(null);
                      });
                    }}
                  >
                    <input
                      className="field-in"
                      aria-label={`Reply to @${c.username ?? "comment"}`}
                      value={reply}
                      maxLength={2200}
                      autoFocus
                      onChange={(e) => setReply(e.target.value)}
                    />
                    <button className="btn cm-btn" disabled={!reply.trim() || busy === c.id}>
                      Send
                    </button>
                  </form>
                )}
              </div>
              <div className="cm-actions">
                {c.canReply && (
                  <button
                    type="button"
                    className="btn ghost cm-btn"
                    disabled={!canModerate || busy === c.id}
                    title={canModerate ? undefined : "Needs the operator"}
                    onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}
                  >
                    Reply{!canModerate && <span className="cm-need"> needs permission</span>}
                  </button>
                )}
                {c.canHide && (
                  <button
                    type="button"
                    className="btn ghost cm-btn"
                    disabled={!canModerate || busy === c.id}
                    onClick={() =>
                      void act(
                        c.id,
                        () => api.post(`${base}/${encodeURIComponent(c.id)}/hide`, { accountId: post.accountId, hidden: !c.isHidden }),
                        c.isHidden ? "Comment shown again." : "Comment hidden.",
                      )
                    }
                  >
                    {c.isHidden ? "Unhide" : "Hide"}
                    {!canModerate && <span className="cm-need"> needs permission</span>}
                  </button>
                )}
                {c.canDelete && (
                  <button
                    type="button"
                    className={`btn ${confirmDelete === c.id ? "danger" : "ghost"} cm-btn`}
                    disabled={!canModerate || busy === c.id}
                    onClick={() => {
                      if (confirmDelete !== c.id) {
                        setConfirmDelete(c.id);
                        setTimeout(() => setConfirmDelete((x) => (x === c.id ? null : x)), 4000);
                        return;
                      }
                      setConfirmDelete(null);
                      void act(
                        c.id,
                        () => api.del(`${base}/${encodeURIComponent(c.id)}?accountId=${encodeURIComponent(post.accountId)}`),
                        "Comment deleted.",
                      );
                    }}
                  >
                    {confirmDelete === c.id ? "Delete for good?" : "Delete"}
                    {!canModerate && <span className="cm-need"> needs permission</span>}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
