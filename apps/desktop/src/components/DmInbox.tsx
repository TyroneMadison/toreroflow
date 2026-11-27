import { useCallback, useEffect, useState } from "react";
import Pf from "./Pf";
import { useToast } from "./Toasts";
import { PF_ID } from "../lib/platforms";
import { useIsPhone } from "../lib/phone";
import { Ic } from "./analytics/phoneBits";
import Modal from "../modals/Modal";
import DmConnect from "./DmConnect";
import {
  api,
  type ClientSummary,
  type DmStatus,
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
export default function DmInbox({ client, onNew }: { client: ClientSummary; onNew?: (n: number) => void }) {
  const toast = useToast();
  const isPhone = useIsPhone();
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
  const [dmStatus, setDmStatus] = useState<DmStatus | null>(null);

  // Which accounts still read through Zernio, for the Connect Instagram card.
  useEffect(() => {
    let live = true;
    api
      .get<DmStatus>(`/dm/status?clientId=${client.id}`)
      .then((s) => live && setDmStatus(s))
      .catch(() => live && setDmStatus(null));
    return () => {
      live = false;
    };
  }, [client.id]);
  const zernioIg = dmStatus?.accounts.filter((a) => a.platform === "instagram" && a.transport !== "native") ?? [];
  const connectFor = zernioIg.find((a) => a.accountId === accountId) ?? zernioIg[0];
  const connectCard = dmStatus && connectFor && (
    <DmConnect clientName={client.name} status={dmStatus} accountId={connectFor.accountId} phone={isPhone} />
  );

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

  // The phone's area chip shows how many messages are new.
  useEffect(() => {
    if (threads) onNew?.(threads.reduce((n, t) => n + t.unreadCount, 0));
  }, [threads, onNew]);

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

  if (isPhone) {
    // Phone (mobile pass): account chips, then the threads as rows; a tap
    // opens the thread full height with the reply box and Send at the bottom.
    const open = threads?.find((t) => t.id === openId) ?? null;
    const who = (t: InboxConversation) => t.participantName ?? t.participantId ?? "someone";
    return (
      <>
        <div id="fl-inbox" className="fl-areah">
          <h2 className="mb-h2">DM inbox</h2>
        </div>
        <div className="mb-chips fl-acchips" role="tablist" aria-label="Inbox account">
          {meta.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={a.id === accountId}
              className={`mb-chip${a.id === accountId ? " on" : ""}`}
              onClick={() => {
                setAccountId(a.id);
                setThreads(null);
                setOpenId(null);
              }}
            >
              <Pf p={PF_ID[a.platform as Platform]} size="sm" />
              {a.handle}
            </button>
          ))}
        </div>
        <p className="mb-sub fl-areasub">Replies go out as the client's account, to a real person. Nothing here sends on its own.</p>
        {connectCard}
        {error && <div className="mb-err">{error}</div>}
        {threads === null && <p className="fl-help">Loading…</p>}
        {threads?.length === 0 && <p className="fl-help">No conversations on this account yet.</p>}
        {!!threads?.length && (
          <section className="mb-card list" aria-label="Conversations">
            {threads.map((t) => (
              <button key={t.id} type="button" className={`fl-th${t.unreadCount > 0 ? " unread" : ""}`} onClick={() => void openThread(t)}>
                {t.participantPicture ? (
                  <img className="fl-av" src={t.participantPicture} alt="" />
                ) : (
                  <span className="fl-av" aria-hidden="true">
                    {who(t).charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="mb-grow">
                  <span className="fl-tt">
                    <b>{who(t)}</b>
                    {t.instagramProfile?.isVerified && (
                      <span className="fl-ver" aria-label="Verified">
                        <Ic name="i-check-circle" />
                      </span>
                    )}
                    {t.instagramProfile?.isFollower && <span className="fl-fl">follows</span>}
                    {t.unreadCount > 0 && <span className="fl-new">{t.unreadCount} new</span>}
                    <span className="fl-when">{ago(t.updatedTime)}</span>
                  </span>
                  {t.lastMessage && <span className="fl-last">{t.lastMessage}</span>}
                </span>
              </button>
            ))}
          </section>
        )}
        {open && (
          <Modal maxWidth={560} onClose={() => setOpenId(null)} label={`Conversation with ${who(open)}`} testId="dm-thread">
            <div className="modal-head">
              <div>
                <h3>{who(open)}</h3>
                <p>As {meta.find((a) => a.id === accountId)?.handle ?? "this account"}. Replies go to a real person.</p>
              </div>
              <button type="button" className="modal-x" aria-label="Close" onClick={() => setOpenId(null)}>
                <svg>
                  <use href="#i-x" />
                </svg>
              </button>
            </div>
            <div className="modal-body fl-thread">
              {messages === null && <p className="fl-help">Loading…</p>}
              {messages?.length === 0 && <p className="fl-help">No messages in this thread.</p>}
              {messages?.map((m) => (
                <div key={m.id} className={`fl-msg ${m.direction}`}>
                  {m.message && <span>{m.message}</span>}
                  {m.attachments.map((a, i) =>
                    a.url && a.type?.startsWith("image") ? (
                      <img key={i} src={a.url} alt="" />
                    ) : a.url ? (
                      <a key={i} href={a.url} target="_blank" rel="noreferrer">
                        {a.type ?? "attachment"}
                      </a>
                    ) : null,
                  )}
                </div>
              ))}
            </div>
            <div className="modal-foot fl-reply">
              <input
                className="mb-input"
                placeholder="Write a reply…"
                aria-label="Reply"
                maxLength={1000}
                enterKeyHint="send"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && reply.trim() && !sending) void send(open);
                }}
              />
              <button type="button" className="btn pri" disabled={sending || !reply.trim()} onClick={() => void send(open)}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </Modal>
        )}
      </>
    );
  }

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
      {connectCard}

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
