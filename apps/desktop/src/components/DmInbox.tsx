import { useCallback, useEffect, useState } from "react";
import Pf from "./Pf";
import { useToast } from "./Toasts";
import { PF_ID } from "../lib/platforms";
import {
  api,
  type ClientSummary,
  type InboxConversation,
  type InboxMessage,
  type Platform,
} from "../lib/api";

/** "2h", "3d", or a date once it stops being useful as an age. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 8) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The client's DM threads, read straight through to the provider.
 *
 * Nothing is copied down. Zernio holds the conversations and Meta expires the
 * attachment URLs inside them within days, so a local mirror would need a
 * webhook to stay honest and would otherwise answer confidently with a week-old
 * thread and broken images. Reading live costs a request and is always right.
 */
export default function DmInbox({ client }: { client: ClientSummary }) {
  const toast = useToast();
  const meta = client.accounts.filter(
    (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"),
  );
  const [accountId, setAccountId] = useState(meta[0]?.id ?? "");
  const [threads, setThreads] = useState<InboxConversation[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setError(null);
    try {
      const r = await api.get<{ conversations: InboxConversation[] }>(
        `/clients/${client.id}/inbox?accountId=${accountId}`,
      );
      setThreads(r.conversations);
    } catch (e) {
      setThreads([]);
      setError(e instanceof Error ? e.message : "could not load the inbox");
    }
  }, [client.id, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openThread = async (t: InboxConversation) => {
    if (openId === t.id) {
      setOpenId(null);
      return;
    }
    setOpenId(t.id);
    setMessages(null);
    setReply("");
    try {
      const r = await api.get<{ messages: InboxMessage[] }>(
        `/clients/${client.id}/inbox/${t.id}?accountId=${accountId}`,
      );
      setMessages(r.messages);
    } catch {
      setMessages([]);
    }
  };

  const send = async (t: InboxConversation) => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      await api.post(`/clients/${client.id}/inbox/${t.id}/reply`, {
        accountId,
        message: reply.trim(),
      });
      setReply("");
      // Re-read rather than appending optimistically: the provider is the only
      // thing that knows whether Meta took it.
      const r = await api.get<{ messages: InboxMessage[] }>(
        `/clients/${client.id}/inbox/${t.id}?accountId=${accountId}`,
      );
      setMessages(r.messages);
    } catch (e) {
      toast.fail("Could not send the reply", e);
    } finally {
      setSending(false);
    }
  };

  if (!meta.length) return null;

  return (
    <div className="dmsec">
      <div className="dmhead">
        <h3>Inbox</h3>
        <div className="igrow" style={{ marginTop: 0 }}>
          {meta.map((a) => (
            <span
              key={a.id}
              className={`revtoggle${a.id === accountId ? " on" : ""}`}
              onClick={() => {
                setAccountId(a.id);
                setThreads(null);
                setOpenId(null);
              }}
            >
              <Pf p={PF_ID[a.platform as Platform]} size="sm" />
              {a.handle}
            </span>
          ))}
        </div>
      </div>
      <p className="lnote">
        Replies go out as the client's account, to a real person. Nothing here sends on its own.
      </p>

      {error && <p className="lnote">{error}</p>}
      {threads === null && <p className="lnote">Loading…</p>}
      {threads?.length === 0 && <p className="lnote">No conversations on this account yet.</p>}

      {threads?.map((t) => (
        <div className="dmcard" key={t.id}>
          <div className="dmtop" style={{ cursor: "pointer" }} onClick={() => void openThread(t)}>
            {t.participantPicture ? (
              <img className="dmav" src={t.participantPicture} alt="" />
            ) : (
              <span className="dmav dmav-blank" />
            )}
            <span className="dmname">
              {t.participantName ?? t.participantId ?? "someone"}
              {t.instagramProfile?.isVerified ? " ✓" : ""}
            </span>
            {t.instagramProfile?.isFollower && <span className="kw">follows</span>}
            {t.unreadCount > 0 && <span className="kw">{t.unreadCount} new</span>}
            <span className="dmscope">{ago(t.updatedTime)}</span>
          </div>
          {openId !== t.id && t.lastMessage && (
            <div className="dmlast">{t.lastMessage.slice(0, 140)}</div>
          )}

          {openId === t.id && (
            <>
              <div className="dmthread">
                {messages === null && <p className="lnote">Loading…</p>}
                {messages?.length === 0 && <p className="lnote">No messages in this thread.</p>}
                {messages?.map((m) => (
                  <div key={m.id} className={`dmmsg ${m.direction}`}>
                    {m.message && <span>{m.message}</span>}
                    {m.attachments.map((a, i) =>
                      a.url && a.type?.startsWith("image") ? (
                        // Meta expires these within days. A dead one is left
                        // broken rather than hiding the message it belongs to.
                        <img key={i} className="dmatt" src={a.url} alt="" />
                      ) : a.url ? (
                        <a key={i} href={a.url} target="_blank" rel="noreferrer">
                          {a.type ?? "attachment"}
                        </a>
                      ) : null,
                    )}
                  </div>
                ))}
              </div>
              <div className="dmreply">
                <input
                  className="field-in"
                  placeholder="Write a reply…"
                  maxLength={1000}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && reply.trim() && !sending) void send(t);
                  }}
                />
                <button className="btn" disabled={sending || !reply.trim()} onClick={() => void send(t)}>
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
