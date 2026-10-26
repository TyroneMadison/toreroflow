import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { Seg } from "../components/PostDetails";
import { Empty, ErrorState, Loading } from "../components/states";

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
