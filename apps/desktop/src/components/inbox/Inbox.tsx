import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DM_STAGE_LABEL, type DmAiDraftView, type DmMessageView, type DmStage, type DmThreadActivity, type DmThreadView } from "@toreroflow/core";
import { api, ApiError, type ClientSummary, type DmStatus } from "../../lib/api";
import {
  atHandle,
  clock,
  convoState,
  CONVO_LABEL,
  CONVO_STATES,
  LIST_TABS,
  markedRead,
  messageSummary,
  NO_FILTERS,
  previewLine,
  replyState,
  shortDate,
  stateChange,
  STAGE_OPTIONS,
  threadItems,
  threadQuery,
  who,
  windowOpen,
  ago,
  type ConvoState,
  type InboxFilters,
  type ReplyState,
} from "../../lib/inbox";
import { useIsPhone } from "../../lib/phone";
import { usePhoneBar } from "../../lib/phoneBar";
import { navigate } from "../../lib/routes";
import { openExternal } from "../../lib/external";
import { useAppState } from "../../state/AppState";
import { Sheet, usePullToRefresh } from "../analytics/phoneBits";
import DmConnect, { startInstagramConnect } from "../DmConnect";
import { useToast } from "../Toasts";
import { Avatar, Channel, EmojiPop, I, Message, Stage, StateChip } from "./parts";
import "./inbox.css";

/*
 * The Inbox (F3, mockups round 1: 02, 02a to 02d, 10). One unified list of
 * Instagram (native or through Zernio, per /dm/status) and Messenger threads.
 * Desktop and web: list, conversation and details side by side. Phone: the
 * list, then the conversation full screen with the tab bar hidden, details
 * and the long-press actions in sheets.
 *
 * Polls every 4 seconds while the page is visible and stops while the tab is
 * hidden; the API asks Zernio at most every 15 seconds behind that. Viewers
 * read everything; every write control turns into the read-only notice, and
 * the server refuses their writes anyway (403). Marking read is the exception
 * (F7): opening a conversation and Mark all as read work for viewers too.
 */

const POLL_MS = 4000;
const RETRY_MS = 15_000;
const PAGE = 30;

interface ListResp {
  threads: DmThreadView[];
  nextCursor: string | null;
  counts: { all: number; open: number; waiting: number; done: number; unread: number; paused: number };
  warnings: string[];
}
interface Detail {
  thread: DmThreadView;
  messages: DmMessageView[];
  activity: DmThreadActivity;
  /** AI replies (F5): on for this account, the draft waiting, the AI's note. Missing on older servers. */
  ai?: ThreadAi;
}
interface ThreadAi {
  enabled: boolean;
  mode: string;
  draft: DmAiDraftView | null;
  note: string | null;
}

const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError && e.status === 403
    ? "You are signed in as a viewer, so this is read-only."
    : e instanceof Error && e.message
      ? e.message
      : fallback;

export default function Inbox({
  client,
  onUnread,
  initialThreadId = null,
}: {
  client: ClientSummary;
  onUnread?(n: number): void;
  /** Contacts' Open conversation: this thread opens first. */
  initialThreadId?: string | null;
}) {
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const isPhone = useIsPhone();
  const toast = useToast();

  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [list, setList] = useState<ListResp | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<DmStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialThreadId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [knownTags, setKnownTags] = useState<string[]>([]);

  const accounts = client.accounts.filter((a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"));

  // Which accounts are native, Zernio, revoked: the Connect card and the reconnect banner.
  useEffect(() => {
    let live = true;
    setStatus(null);
    api
      .get<DmStatus>(`/dm/status?clientId=${client.id}`)
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client.id]);

  // A new brand starts clean (not on the first render: that keeps initialThreadId).
  const shownClient = useRef(client.id);
  useEffect(() => {
    if (shownClient.current === client.id) return;
    shownClient.current = client.id;
    setFilters(NO_FILTERS);
    setSearchText("");
    setList(null);
    setListErr(null);
    setOpenId(null);
    setDetail(null);
    setLimit(PAGE);
  }, [client.id]);

  // Typing settles for 300ms before it filters.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText })), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // Newest request wins: a slow poll never overwrites a newer filter's answer.
  // While a mark read is on its way, polls are dropped too: they could still
  // carry the old counts and bring the dots back. Its own reread follows it.
  const seq = useRef(0);
  const marking = useRef(0);
  const loadList = useCallback(
    async (silent: boolean) => {
      const n = ++seq.current;
      if (!silent) setRefreshing(true);
      try {
        const r = await api.get<ListResp>(`/clients/${client.id}/dm/threads${threadQuery(filters, limit)}`);
        if (n !== seq.current || marking.current) return;
        setList(r);
        setListErr(null);
        setLastLoaded(new Date());
        setKnownTags((prev) => {
          const all = new Set(prev);
          for (const t of r.threads) for (const tag of t.contact.tags) all.add(tag);
          return all.size === prev.length ? prev : [...all].sort();
        });
      } catch (e) {
        if (n === seq.current) setListErr(errText(e, "could not load the Inbox"));
      } finally {
        if (n === seq.current) setRefreshing(false);
      }
    },
    [client.id, filters, limit],
  );

  useEffect(() => {
    void loadList(false);
  }, [loadList]);

  // Every 4 seconds while visible; at once when the tab comes back.
  useEffect(() => {
    const tick = () => !document.hidden && void loadList(true);
    const id = window.setInterval(tick, POLL_MS);
    const vis = () => !document.hidden && void loadList(true);
    document.addEventListener("visibilitychange", vis);
    return () => (clearInterval(id), document.removeEventListener("visibilitychange", vis));
  }, [loadList]);

  // Could not load at all: try again every 15 seconds on its own (mockup 10d).
  useEffect(() => {
    if (list || !listErr) return;
    const t = window.setTimeout(() => void loadList(true), RETRY_MS);
    return () => clearTimeout(t);
  }, [list, listErr, loadList]);

  // The rail's and the phone chip's unread count: the whole brand, not a filtered view.
  const unfiltered = !filters.search && !filters.stage && !filters.tag && !filters.accountId && !filters.platform;
  useEffect(() => {
    if (list && unfiltered) onUnread?.(list.counts.unread);
  }, [list, unfiltered, onUnread]);

  // Desktop opens the newest conversation so the panes are never empty.
  useEffect(() => {
    if (!isPhone && !openId && list?.threads.length) setOpenId(list.threads[0]!.id);
  }, [isPhone, openId, list]);

  const detailSeq = useRef(0);
  const loadDetail = useCallback(
    async (id: string, silent: boolean) => {
      const n = ++detailSeq.current;
      if (!silent) (setDetail(null), setDetailErr(null));
      try {
        const r = await api.get<Detail>(`/clients/${client.id}/dm/threads/${id}`);
        if (n !== detailSeq.current) return;
        setDetail(r);
        setDetailErr(null);
      } catch (e) {
        if (n === detailSeq.current) setDetailErr(errText(e, "could not load this conversation"));
      }
    },
    [client.id],
  );

  useEffect(() => {
    if (openId) void loadDetail(openId, false);
    else setDetail(null);
  }, [openId, loadDetail]);

  /**
   * Mark one conversation read, or with no id the whole brand (F7). The dots
   * and counts clear at once; the server saves it for every device, and a
   * reread of the list reconciles. Viewers may too (it sends nobody anything).
   */
  const markRead = useCallback(
    async (threadId?: string) => {
      const cid = client.id;
      marking.current++;
      setList((l) => (l ? markedRead(l, threadId) : l));
      setDetail((d) => (d && (!threadId || d.thread.id === threadId) ? { ...d, thread: { ...d.thread, unread: 0 } } : d));
      try {
        await api.post(`/clients/${cid}/dm/threads/${threadId ? `${threadId}/read` : "read-all"}`);
        // The Dock's count rereads now, not at its next 2-minute tick.
        window.dispatchEvent(new Event("toreroflow:dm-read"));
      } catch (e) {
        if (!threadId) toast.fail("Could not mark everything as read", e);
      } finally {
        marking.current--;
        if (shownClient.current === cid) void loadList(true);
      }
    },
    [client.id, loadList, toast],
  );

  // Opening a conversation marks it read: a click, the desktop's first pick,
  // Contacts' "Open conversation", and a new message while it is open. Once
  // per message: a read the server refused is not retried in a loop.
  const openRow = list?.threads.find((t) => t.id === openId) ?? null;
  const openShown = openRow ?? (detail && detail.thread.id === openId ? detail.thread : null);
  const openKey = openShown ? `${openShown.id}:${openShown.lastMessageAt ?? ""}` : "";
  const triedRead = useRef("");
  useEffect(() => {
    if (!openShown || openShown.unread <= 0 || triedRead.current === openKey) return;
    triedRead.current = openKey;
    void markRead(openShown.id);
  }, [openShown, openKey, markRead]);

  // A poll that shows the open conversation moved reads it again.
  useEffect(() => {
    if (!openRow || !detail || detail.thread.id !== openRow.id) return;
    if (openRow.lastMessageAt !== detail.thread.lastMessageAt || openRow.lastPreview !== detail.thread.lastPreview) {
      void loadDetail(openRow.id, true);
    }
  }, [openRow, detail, loadDetail]);

  /** One thread changed (PATCH, pause): both the list row and the open conversation take it. */
  const applyThread = useCallback((t: DmThreadView) => {
    setList((l) => (l ? { ...l, threads: l.threads.map((x) => (x.id === t.id ? { ...t, unread: x.unread } : x)) } : l));
    setDetail((d) => (d && d.thread.id === t.id ? { ...d, thread: { ...t, unread: 0 } } : d));
  }, []);

  const patch = useCallback(
    async (t: DmThreadView, body: Record<string, unknown>) => {
      try {
        const r = await api.patch<{ thread: DmThreadView }>(`/clients/${client.id}/dm/threads/${t.id}`, body);
        applyThread(r.thread);
      } catch (e) {
        toast.fail("Could not save that change", e);
      }
    },
    [client.id, applyThread, toast],
  );

  const setPause = useCallback(
    async (t: DmThreadView, pause: boolean) => {
      try {
        const r = await api.post<{ thread: DmThreadView }>(`/clients/${client.id}/dm/threads/${t.id}/${pause ? "pause" : "resume"}`);
        applyThread(r.thread);
      } catch (e) {
        toast.fail(pause ? "Could not pause auto replies" : "Could not resume auto replies", e);
      }
    },
    [client.id, applyThread, toast],
  );

  /** AI replies in this one chat (F5): off, or "Let the AI answer again". */
  const setAi = useCallback(
    async (t: DmThreadView, body: { off?: boolean; resume?: true }) => {
      try {
        const r = await api.post<{ thread: DmThreadView }>(`/clients/${client.id}/dm/threads/${t.id}/ai`, body);
        applyThread(r.thread);
      } catch (e) {
        toast.fail("Could not change AI replies for this chat", e);
      }
    },
    [client.id, applyThread, toast],
  );

  const setConvo = useCallback(
    async (t: DmThreadView, to: ConvoState) => {
      const c = stateChange(t, to);
      if (c.status) await patch(t, { status: c.status });
      if (c.pause !== undefined) await setPause(t, c.pause);
    },
    [patch, setPause],
  );

  // ---------------------------------------------------------------------------
  // States (mockup 10)
  // ---------------------------------------------------------------------------

  const igOnZernio = (status?.accounts ?? []).filter((a) => a.platform === "instagram" && a.transport !== "native");
  const revoked = (status?.accounts ?? []).filter((a) => a.transport === "native" && (a.state === "revoked" || a.state === "error"));
  const brandNew = list && list.threads.length === 0 && list.counts.all === 0 && unfiltered && filters.tab === "all" && !filters.unread;

  const reconnectBanner = revoked.map((a) => (
    <div key={a.accountId} className={`ibx-banner bad${isPhone ? " ph" : ""}`} role="alert" data-testid="dm-reconnect">
      <I name="i-alert" />
      <div className="bt">
        <b>Instagram stopped accepting replies for @{a.handle.replace(/^@/, "")}</b>
        Reconnect to keep DMs and automations running. Nothing sends from this account until you do.
      </div>
      {!viewer && !isPhone && (
        <button type="button" className="btn sm" onClick={() => void startInstagramConnect(a.accountId, toast)}>
          Reconnect
        </button>
      )}
      {!viewer && isPhone && (
        <button type="button" className="mb-btn sm block" onClick={() => void startInstagramConnect(a.accountId, toast)}>
          Reconnect @{a.handle.replace(/^@/, "")}
        </button>
      )}
    </div>
  ));

  const usePhoneThread = isPhone && !!openId;
  usePhoneBar(usePhoneThread ? { title: "Conversation", back: () => setOpenId(null), hide: true } : null);
  const ptr = usePullToRefresh(() => void loadList(false), refreshing && !!list, isPhone && !openId);

  if (!accounts.length) {
    return (
      <div className="ibx-wrap" data-testid="dm-inbox" data-state="empty">
        <DmConnect clientName={client.name} status={status} accountId={null} phone={isPhone} />
      </div>
    );
  }

  if (!list) {
    return (
      <div className="ibx-wrap" data-testid="dm-inbox" data-state={listErr ? "error" : "loading"}>
        {listErr ? (
          <CouldNotLoad phone={isPhone} lastLoaded={lastLoaded} onRetry={() => void loadList(false)} />
        ) : (
          <div className={isPhone ? "mb-card ibx-skel" : "card glass ibx-skel"} aria-busy="true" role="status" aria-label="Loading the Inbox">
            <span className="skel" style={{ width: "40%" }} />
            <span className="skel" />
            <span className="skel" style={{ width: "75%" }} />
          </div>
        )}
      </div>
    );
  }

  if (brandNew) {
    return (
      <div className="ibx-wrap" data-testid="dm-inbox" data-state="empty">
        {reconnectBanner}
        {igOnZernio.length ? (
          <DmConnect clientName={client.name} status={status} accountId={igOnZernio[0]!.accountId} phone={isPhone} />
        ) : (
          <NoConversations phone={isPhone} handle={accounts.find((a) => a.platform === "instagram")?.handle ?? accounts[0]!.handle} />
        )}
        {list.warnings.map((w) => (
          <p key={w} className="ibx-warn">
            {w}
          </p>
        ))}
      </div>
    );
  }

  const listPane = (
    <ThreadList
      phone={isPhone}
      list={list}
      filters={filters}
      setFilters={(f) => (setFilters(f), setLimit(PAGE))}
      searchText={searchText}
      setSearchText={setSearchText}
      accounts={accounts}
      knownTags={knownTags}
      openId={openId}
      onOpen={setOpenId}
      onMore={() => setLimit((l) => l + PAGE)}
      onFilter={() => setFilterOpen(true)}
      onMarkAll={() => void markRead()}
      brand={client.name}
      lastLoaded={listErr ? lastLoaded : null}
    />
  );

  const connectBar = igOnZernio.length > 0 && (
    <DmConnect clientName={client.name} status={status} accountId={igOnZernio[0]!.accountId} phone={isPhone} compact />
  );

  const convo = (t: DmThreadView) => (
    <Conversation
      key={t.id}
      phone={isPhone}
      clientId={client.id}
      thread={t}
      detail={detail?.thread.id === t.id ? detail : null}
      detailErr={detailErr}
      viewer={viewer}
      onBack={() => setOpenId(null)}
      onInfo={() => setInfoOpen(true)}
      onReload={() => void loadDetail(t.id, true)}
      onSent={() => (void loadDetail(t.id, true), void loadList(true))}
      onPause={(p) => void setPause(t, p)}
      onConvo={(s) => void setConvo(t, s)}
    />
  );

  const shown = detail?.thread ?? openRow;

  if (isPhone) {
    return (
      <div className="ibx-wrap ph" data-testid="dm-inbox" data-state="ready">
        {ptr}
        {reconnectBanner}
        {connectBar}
        {listPane}
        {list.warnings.map((w) => (
          <p key={w} className="ibx-warn">
            {w}
          </p>
        ))}
        {filterOpen && (
          <FilterSheet filters={filters} knownTags={knownTags} onApply={(f) => (setFilters(f), setLimit(PAGE), setFilterOpen(false))} onClose={() => setFilterOpen(false)} />
        )}
        {usePhoneThread && shown && createPortal(<div className="ibx-phone-thread">{convo(shown)}</div>, document.body)}
        {usePhoneThread && shown && infoOpen && (
          <Sheet label="Details" title="Details" onClose={() => setInfoOpen(false)} className="ibx-detsheet" testId="dm-details-sheet" top
            foot={
              viewer ? undefined : (
                <>
                  <button type="button" className="mb-btn" onClick={() => void setConvo(shown, convoState(shown) === "flagged" ? "active" : "flagged")}>
                    <I name="i-alert" />
                    {convoState(shown) === "flagged" ? "Unflag" : "Flag"}
                  </button>
                  <button type="button" className="mb-btn" onClick={() => (void setConvo(shown, "done"), setInfoOpen(false))}>
                    <I name="i-check" />
                    Mark done
                  </button>
                </>
              )
            }
          >
            <Details phone thread={shown} activity={detail?.thread.id === shown.id ? detail.activity : null} ai={detail?.thread.id === shown.id ? (detail.ai ?? null) : null} onAi={(b) => void setAi(shown, b)} viewer={viewer} knownTags={knownTags} onPatch={(b) => void patch(shown, b)} onPause={(p) => void setPause(shown, p)} onConvo={(s) => void setConvo(shown, s)} />
          </Sheet>
        )}
      </div>
    );
  }

  return (
    <div className="ibx-wrap" data-testid="dm-inbox" data-state="ready">
      {reconnectBanner}
      {connectBar}
      <div className="ibx">
        {listPane}
        {shown ? (
          convo(shown)
        ) : (
          <section className="pane-thread ibx-none">
            <I name="i-inbox" />
            <p>{list.threads.length ? "Pick a conversation." : "No conversations match these filters."}</p>
          </section>
        )}
        <section className="pane-info" aria-label="Details">
          {shown && (
            <Details
              thread={shown}
              activity={detail?.thread.id === shown.id ? detail.activity : null}
              ai={detail?.thread.id === shown.id ? (detail.ai ?? null) : null}
              onAi={(b) => void setAi(shown, b)}
              viewer={viewer}
              knownTags={knownTags}
              onPatch={(b) => void patch(shown, b)}
              onPause={(p) => void setPause(shown, p)}
              onConvo={(s) => void setConvo(shown, s)}
            />
          )}
        </section>
      </div>
      {list.warnings.map((w) => (
        <p key={w} className="ibx-warn">
          {w}
        </p>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// The list
// -----------------------------------------------------------------------------

function ThreadList({
  phone,
  list,
  filters,
  setFilters,
  searchText,
  setSearchText,
  accounts,
  knownTags,
  openId,
  onOpen,
  onMore,
  onFilter,
  onMarkAll,
  brand,
  lastLoaded,
}: {
  phone: boolean;
  list: ListResp;
  filters: InboxFilters;
  setFilters(f: InboxFilters): void;
  searchText: string;
  setSearchText(s: string): void;
  accounts: ClientSummary["accounts"];
  knownTags: string[];
  openId: string | null;
  onOpen(id: string): void;
  onMore(): void;
  onFilter(): void;
  /** F7: every conversation of the brand, whatever the filters show. */
  onMarkAll(): void;
  brand: string;
  lastLoaded: Date | null;
}) {
  const now = Date.now();
  const c = list.counts;
  const markAll = (
    <button
      type="button"
      className={phone ? "ibx-markall" : "ibx-btn ghost ibx-markall"}
      disabled={c.unread === 0}
      title={`Mark every ${brand} conversation as read`}
      onClick={onMarkAll}
      data-testid="dm-mark-all-read"
    >
      Mark all as read
    </button>
  );
  const chips = (
    <nav className={`ibx-chips${phone ? " accs" : " scroll"}`} aria-label="Accounts">
      <button type="button" className={`ibx-chip${!filters.accountId ? " on" : ""}`} aria-pressed={!filters.accountId} onClick={() => setFilters({ ...filters, accountId: null })}>
        All accounts
      </button>
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`ibx-chip${filters.accountId === a.id ? " on" : ""}`}
          aria-pressed={filters.accountId === a.id}
          onClick={() => setFilters({ ...filters, accountId: a.id })}
          data-testid={`dm-account-${a.id}`}
        >
          <Channel platform={a.platform === "facebook" ? "facebook" : "instagram"} label="" />
          {a.platform === "facebook" ? "Messenger" : `@${a.handle.replace(/^@/, "")}`}
        </button>
      ))}
    </nav>
  );
  const seg = (
    <div className="ibx-seg full" role="tablist" aria-label="Conversation state">
      {LIST_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={filters.tab === t.id} className={filters.tab === t.id ? "on" : undefined} onClick={() => setFilters({ ...filters, tab: t.id })} data-testid={`dm-tab-${t.id}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
  const search = (
    <label className="ibx-input round">
      <I name="i-search" />
      <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search @username" aria-label="Search conversations" data-testid="dm-search" />
    </label>
  );
  const rows = list.threads.map((t) => {
    const unread = t.unread > 0;
    const name = t.platform === "facebook" ? who(t.contact) : (atHandle(t.contact)?.slice(1) ?? who(t.contact));
    return (
      <button
        key={t.id}
        type="button"
        className={`ibx-crow${unread ? " unread" : ""}${t.id === openId && !phone ? " is-sel" : ""}`}
        aria-current={t.id === openId && !phone ? "true" : undefined}
        onClick={() => onOpen(t.id)}
        data-testid={`dm-thread-${t.id}`}
      >
        <Avatar contact={t.contact} size={phone ? 52 : 44} win={windowOpen(t, now)} />
        <span className="grow">
          {phone ? (
            <>
              <span className="l1">
                <span className="who">{name}</span>
                <Channel platform={t.platform} />
                <span className="when">{ago(t.lastMessageAt, now)}</span>
              </span>
              <span className="l2">
                <span className="pv">{previewLine(t)}</span>
                {unread && <span className="udot" aria-label={`${t.unread} unread`} />}
              </span>
              <span className="l2">
                <StateChip thread={t} />
                <Stage stage={t.contact.stage} />
              </span>
            </>
          ) : (
            <>
              <span className="l1">
                <Channel platform={t.platform} />
                <span className="who">{name}</span>
                <Stage stage={t.contact.stage} />
                <span className="when">{ago(t.lastMessageAt, now)}</span>
              </span>
              <span className="l2">
                <StateChip thread={t} />
                <span className="pv">{previewLine(t)}</span>
                {unread && <span className="udot" aria-label={`${t.unread} unread`} />}
              </span>
            </>
          )}
        </span>
      </button>
    );
  });
  const more = list.nextCursor && (
    <button type="button" className={phone ? "ibx-showmore" : "ibx-more"} onClick={onMore}>
      Show more
    </button>
  );
  const none = !list.threads.length && <p className="ibx-nomatch">No conversations match these filters.</p>;

  if (phone) {
    return (
      <>
        {chips}
        <div className="ibx-ctl">
          {search}
          <button type="button" className={`mb-ib${filters.stage || filters.tag || filters.platform || filters.unread ? " on" : ""}`} aria-label="Filter by stage, tag and channel" onClick={onFilter} data-testid="dm-filter">
            <I name="i-filter" />
          </button>
        </div>
        {seg}
        <div className="ibx-metarow">
          <span>
            {c.all} conversations, {c.unread} unread
          </span>
          {lastLoaded ? <span>Offline. Loaded {clock(lastLoaded)}</span> : c.unread > 0 ? markAll : <span>Pull to refresh</span>}
        </div>
        <section className="mb-card list ibx-list" aria-label="Conversations">
          {rows}
          {none}
          {more}
        </section>
        {!list.nextCursor && list.threads.length > 0 && <p className="ibx-foot">Showing {list.threads.length} of {list.threads.length}.</p>}
      </>
    );
  }

  return (
    <section className="pane-list" aria-label="Conversations">
      <div className="lhead">
        <div className="sb ibx-lh1">
          <h3>Inbox</h3>
          <span className="row">
            <span className="tiny">
              {lastLoaded ? `Offline. Loaded ${clock(lastLoaded)} · ` : ""}
              <button type="button" className={`ibx-unread${filters.unread ? " on" : ""}`} aria-pressed={filters.unread} title={filters.unread ? "Show every conversation" : "Show unread only"} onClick={() => setFilters({ ...filters, unread: !filters.unread })} data-testid="dm-unread">
                {c.unread} unread
              </button>{" "}
              · {c.open} open
            </span>
            {markAll}
          </span>
        </div>
        {seg}
        {search}
        {chips}
        <div className="sb">
          <span className="tiny">{c.all} conversations</span>
          <span className="row">
            <label className="ibx-btn sm ibx-pick">
              <span className="vh">Stage</span>
              <select value={filters.stage ?? ""} onChange={(e) => setFilters({ ...filters, stage: (e.target.value || null) as DmStage | null })} data-testid="dm-stage-filter">
                <option value="">Any stage</option>
                {STAGE_OPTIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <I name="i-chev" />
            </label>
            <label className="ibx-btn sm ibx-pick">
              <span className="vh">Tag</span>
              <select value={filters.tag ?? ""} onChange={(e) => setFilters({ ...filters, tag: e.target.value || null })} data-testid="dm-tag-filter">
                <option value="">Any tag</option>
                {knownTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <I name="i-chev" />
            </label>
          </span>
        </div>
      </div>
      <div className="ibx-rows">
        {rows}
        {none}
        {more}
      </div>
    </section>
  );
}

/** Phone: stage, tag, channel and unread in one sheet (the list has room only for search). */
function FilterSheet({ filters, knownTags, onApply, onClose }: { filters: InboxFilters; knownTags: string[]; onApply(f: InboxFilters): void; onClose(): void }) {
  const [f, setF] = useState(filters);
  return (
    <Sheet
      label="Filter conversations"
      title="Filter"
      onClose={onClose}
      testId="dm-filter-sheet"
      foot={
        <>
          <button type="button" className="mb-btn ghost" onClick={() => onApply({ ...f, stage: null, tag: null, platform: null, unread: false })}>
            Reset
          </button>
          <button type="button" className="mb-btn pri" onClick={() => onApply(f)}>
            Show conversations
          </button>
        </>
      }
    >
      <div className="ibx-field">
        <span className="ibx-flab">Stage</span>
        <div className="ibx-wchips">
          {STAGE_OPTIONS.map((s) => (
            <button key={s.id} type="button" className={`mb-chip${f.stage === s.id ? " on" : ""}`} aria-pressed={f.stage === s.id} onClick={() => setF({ ...f, stage: f.stage === s.id ? null : s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {knownTags.length > 0 && (
        <div className="ibx-field">
          <span className="ibx-flab">Tag</span>
          <div className="ibx-wchips">
            {knownTags.map((t) => (
              <button key={t} type="button" className={`mb-chip${f.tag === t ? " on" : ""}`} aria-pressed={f.tag === t} onClick={() => setF({ ...f, tag: f.tag === t ? null : t })}>
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ibx-field">
        <span className="ibx-flab">Channel</span>
        <div className="ibx-seg ph" role="radiogroup" aria-label="Channel">
          {([null, "instagram", "facebook"] as const).map((p) => (
            <button key={p ?? "all"} type="button" role="radio" aria-checked={f.platform === p} className={f.platform === p ? "on" : undefined} onClick={() => setF({ ...f, platform: p })}>
              {p === null ? "All" : p === "instagram" ? "Instagram" : "Messenger"}
            </button>
          ))}
        </div>
      </div>
      <button type="button" role="switch" aria-checked={f.unread} className="ibx-optrow" onClick={() => setF({ ...f, unread: !f.unread })}>
        <span className="lt">
          <b>Unread only</b>
          <small>Conversations with messages nobody has opened</small>
        </span>
        <span className={`ibx-tog${f.unread ? " on" : ""}`} aria-hidden="true" />
      </button>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// The conversation
// -----------------------------------------------------------------------------

function Conversation({
  phone,
  clientId,
  thread,
  detail,
  detailErr,
  viewer,
  onBack,
  onInfo,
  onReload,
  onSent,
  onPause,
  onConvo,
}: {
  phone: boolean;
  clientId: string;
  thread: DmThreadView;
  detail: Detail | null;
  detailErr: string | null;
  viewer: boolean;
  onBack(): void;
  onInfo(): void;
  onReload(): void;
  onSent(): void;
  onPause(pause: boolean): void;
  onConvo(s: ConvoState): void;
}) {
  const toast = useToast();
  const [replyTo, setReplyTo] = useState<DmMessageView | null>(null);
  const [actionsFor, setActionsFor] = useState<DmMessageView | null>(null);
  const [rate, setRate] = useState(1);
  const msgsRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => threadItems(detail?.messages ?? []), [detail?.messages]);
  const byExternal = useMemo(() => new Map((detail?.messages ?? []).map((m) => [m.externalId, m])), [detail?.messages]);
  const state = replyState(thread, viewer);
  const native = thread.source === "native";
  const name = who(thread.contact);
  const handle = atHandle(thread.contact);

  // Newest at the bottom, scrolled into view when it arrives.
  const lastId = detail?.messages.at(-1)?.id;
  const hasDetail = !!detail;
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Photos and videos load after the first paint and push the newest message
    // down; follow them while the reader is still at the bottom.
    let pinned = true;
    const onScroll = () => (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    const onLoad = () => pinned && (el.scrollTop = el.scrollHeight);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("load", onLoad, true);
    el.addEventListener("loadedmetadata", onLoad, true);
    // The composer growing (Replying to, a photo) shrinks the list: stay at the bottom.
    const ro = new ResizeObserver(onLoad);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("load", onLoad, true);
      el.removeEventListener("loadedmetadata", onLoad, true);
    };
  }, [lastId, hasDetail]);

  const copy = (m: DmMessageView) => {
    const text = m.transcript && !m.text ? m.transcript : messageSummary(m);
    void navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    );
  };

  const head = (
    <div className="thead">
      {phone && (
        <button type="button" className="ibx-ib ghost" aria-label="Back to Inbox" onClick={onBack} data-testid="dm-back">
          <I name="i-chev-l" />
        </button>
      )}
      <Avatar contact={thread.contact} size={phone ? 36 : undefined} win={windowOpen(thread)} />
      <div className="nm grow">
        <b>{name}</b>
        <small>
          {handle ?? (thread.platform === "facebook" ? "Messenger" : "")}
          <Channel platform={thread.platform} label={phone ? undefined : thread.platform === "facebook" ? "Messenger" : "Instagram"} />
        </small>
      </div>
      {phone ? (
        <>
          {convoState(thread) === "done" && <StateChip thread={thread} />}
          <button
            type="button"
            className="ibx-aip"
            disabled={viewer}
            onClick={() => onPause(!thread.pausedAt)}
            aria-label={thread.pausedAt ? "Auto replies paused. Tap to resume" : "Auto replies on. Tap to pause"}
            data-testid="dm-pause"
          >
            <span className={`ibx-sdot${thread.pausedAt ? " off" : ""}`} />
            {thread.pausedAt ? "Paused" : "Auto on"}
          </button>
          <button type="button" className="ibx-ib ghost" aria-label="Details" onClick={onInfo} data-testid="dm-info">
            <I name="i-info" />
          </button>
        </>
      ) : (
        <>
          {convoState(thread) !== "done" && (
            <span className="ibx-aipill">
              <span className={`ibx-sdot${thread.pausedAt ? " off" : ""}`} />
              {thread.pausedAt ? "Auto replies paused" : "Auto replies on"}
              {!viewer && (
                <>
                  <span className="t3">·</span>
                  <button type="button" className="acc" onClick={() => onPause(!thread.pausedAt)} data-testid="dm-pause">
                    {thread.pausedAt ? "Resume" : "Pause"}
                  </button>
                </>
              )}
            </span>
          )}
          {!viewer && convoState(thread) !== "done" && (
            <button type="button" className="ibx-btn sm icon ghost" aria-label="Mark done" title="Mark done" onClick={() => onConvo("done")} data-testid="dm-done">
              <I name="i-check" />
            </button>
          )}
          {convoState(thread) === "done" && <StateChip thread={thread} />}
        </>
      )}
    </div>
  );

  const body = !detail ? (
    detailErr ? (
      <div className="ibx-msgs center">
        <p className="ibx-nomatch">{detailErr}</p>
        <button type="button" className={phone ? "mb-btn sm" : "btn sm"} onClick={onReload}>
          <I name="i-refresh" />
          Retry
        </button>
      </div>
    ) : (
      <div className="ibx-msgs center" aria-busy="true">
        <p className="ibx-nomatch">Loading the conversation…</p>
      </div>
    )
  ) : (
    <div className="ibx-msgs" ref={msgsRef} role="log" aria-label={`Messages with ${name}`}>
      {items.length === 0 && <p className="ibx-nomatch">No messages in this conversation yet.</p>}
      {items.map((it) =>
        it.kind === "sep" ? (
          <div key={it.key} className="ibx-dsep">
            {it.label}
          </div>
        ) : (
          <Message
            key={it.key}
            m={it.m}
            pos={it.pos}
            avatar={it.avatar}
            contact={thread.contact}
            quote={it.m.replyTo ? messageSummary(byExternal.get(it.m.replyTo) ?? { text: null, attachments: [], unsent: false }) : null}
            accountHandle={thread.accountHandle.replace(/^@/, "")}
            rate={rate}
            onBroken={onReload}
            onLongPress={phone ? () => setActionsFor(it.m) : undefined}
            actions={
              !phone && !it.m.unsent ? (
                <span className="ibx-mact">
                  {native && state.kind === "open" && (
                    <button type="button" className="ibx-ib sm" aria-label="Reply to this message" title="Reply" onClick={() => setReplyTo(it.m)}>
                      <I name="i-reply" />
                    </button>
                  )}
                  <button type="button" className="ibx-ib sm" aria-label="Copy this message" title="Copy" onClick={() => copy(it.m)}>
                    <I name="i-copy" />
                  </button>
                </span>
              ) : undefined
            }
          />
        ),
      )}
    </div>
  );

  return (
    <section className={phone ? "ibx-pthread" : "pane-thread"} aria-label={`Conversation with ${name}`} data-testid="dm-thread">
      {head}
      {body}
      <Composer
        phone={phone}
        clientId={clientId}
        thread={thread}
        state={state}
        replyTo={replyTo}
        ai={detail?.ai ?? null}
        onReload={onReload}
        onCancelReply={() => setReplyTo(null)}
        onSent={() => (setReplyTo(null), onSent())}
      />
      {phone && actionsFor && (
        <Sheet label="Message actions" title={<span className="vh">Message actions</span>} onClose={() => setActionsFor(null)} className="ibx-actsheet" testId="dm-actions" top
          foot={
            <button type="button" className="mb-btn block" onClick={() => setActionsFor(null)}>
              Cancel
            </button>
          }
        >
          <p className="ibx-minfo">
            {actionsFor.attachments[0]?.type === "audio" ? "Voice message" : "Message"} from {actionsFor.direction === "in" ? name : "you"}
            {actionsFor.sentAt ? `, ${new Date(actionsFor.sentAt).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}` : ""}.
            {actionsFor.transcript ? " Transcript made automatically." : ""}
          </p>
          <div className="mb-card list">
            {native && state.kind === "open" && (
              <button type="button" className="mb-lrow" onClick={() => (setReplyTo(actionsFor), setActionsFor(null))}>
                <I name="i-reply" />
                <span className="mb-lt">
                  <b>Reply</b>
                </span>
              </button>
            )}
            <button type="button" className="mb-lrow" onClick={() => (copy(actionsFor), setActionsFor(null))}>
              <I name="i-copy" />
              <span className="mb-lt">
                <b>{actionsFor.transcript && !actionsFor.text ? "Copy transcript" : "Copy text"}</b>
              </span>
            </button>
            {actionsFor.attachments.some((a) => a.type === "audio") && (
              <button type="button" className="mb-lrow" onClick={() => (setRate((r) => (r === 1 ? 1.5 : 1)), setActionsFor(null))}>
                <I name="i-play" />
                <span className="mb-lt">
                  <b>{rate === 1 ? "Play at 1.5x" : "Play at normal speed"}</b>
                </span>
              </button>
            )}
            {!viewer && (
              <button type="button" className="mb-lrow" onClick={() => (onConvo(convoState(thread) === "flagged" ? "active" : "flagged"), setActionsFor(null))}>
                <I name="i-alert" />
                <span className="mb-lt">
                  <b>{convoState(thread) === "flagged" ? "Unflag conversation" : "Flag conversation"}</b>
                </span>
              </button>
            )}
          </div>
        </Sheet>
      )}
    </section>
  );
}

const WHY_CLOSED_1 = "Instagram allows replies within 24 hours of the person's last message. After that the composer locks, and automations skip this person too.";
const WHY_CLOSED_2 = "Their next message opens a new 24 hour window, shown as a green dot on their picture.";

/** Text, a photo, the reply window under it, or the notice that says why it is locked. */
function Composer({
  phone,
  clientId,
  thread,
  state,
  replyTo,
  ai,
  onReload,
  onCancelReply,
  onSent,
}: {
  phone: boolean;
  clientId: string;
  thread: DmThreadView;
  state: ReplyState;
  replyTo: DmMessageView | null;
  ai: ThreadAi | null;
  onReload(): void;
  onCancelReply(): void;
  onSent(): void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<{ url: string; name: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [emoji, setEmoji] = useState(false);
  // The AI draft the text was taken from (F5): sent as is or edited, it counts as that draft.
  const [fromDraft, setFromDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const name = who(thread.contact);
  const native = thread.source === "native";
  const messenger = thread.platform === "facebook";

  useEffect(() => {
    if (replyTo) box.current?.focus();
  }, [replyTo]);
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.preview);
    },
    [photo],
  );

  const grow = () => {
    const el = box.current;
    if (el) (el.style.height = "auto"), (el.style.height = `${Math.min(el.scrollHeight, 140)}px`);
  };

  const send = async (direct?: { text: string; draftId: string }) => {
    const body = direct?.text ?? text.trim();
    if (busy || (!body && !photo)) return;
    setBusy(true);
    try {
      const draftId = direct?.draftId ?? fromDraft;
      await api.post(`/clients/${clientId}/dm/threads/${thread.id}/reply`, {
        ...(body ? { text: body } : {}),
        ...(photo && !direct ? { media: { type: "image", url: photo.url } } : {}),
        ...(replyTo && native ? { replyTo: replyTo.externalId } : {}),
        ...(draftId ? { draftId } : {}),
      });
      if (!direct) setText("");
      setFromDraft(null);
      setPhoto(null);
      requestAnimationFrame(grow);
      onSent();
    } catch (e) {
      toast.fail("Could not send the reply", e);
      onSent();
    } finally {
      setBusy(false);
    }
  };

  const draft = ai?.draft ?? null;
  const askAi = async () => {
    setAsking(true);
    try {
      await api.post(`/clients/${clientId}/dm/threads/${thread.id}/ai-draft`);
      // The worker writes it in a few seconds; look again until it is there.
      for (const ms of [2500, 4000, 6000, 9000]) window.setTimeout(onReload, ms);
    } catch (e) {
      toast.fail("Could not ask the AI for a draft", e);
    } finally {
      window.setTimeout(() => setAsking(false), 2500);
    }
  };
  const discard = async (id: string) => {
    try {
      await api.post(`/clients/${clientId}/dm/ai/drafts/${id}/discard`);
      if (fromDraft === id) setFromDraft(null);
      onReload();
    } catch (e) {
      toast.fail("Could not discard the draft", e);
    }
  };
  const ready = draft && (draft.status === "draft" || draft.status === "queued");
  const aiCard = draft && (
    <div className={`ibx-repl ai${ready || draft.status === "writing" ? "" : " note"}`} data-testid="dm-ai-draft">
      <I name="i-spark" />
      <span className="grow">
        {draft.status === "writing" ? (
          <b>The AI is writing a draft...</b>
        ) : ready ? (
          <>
            <b>{draft.status === "queued" && draft.sendAt ? `AI reply, sends on its own at ${new Date(draft.sendAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "AI draft"}</b>
            <span>{draft.bubbles.join(" / ")}</span>
          </>
        ) : (
          <>
            <b>{draft.status === "handoff" ? "The AI handed this to you" : draft.status === "skipped" ? "No reply needed" : "No draft"}</b>
            <span>{draft.reason ?? ""}</span>
          </>
        )}
      </span>
      {ready && (
        <>
          <button type="button" className="ibx-btn ghost" onClick={() => (setText(draft.bubbles.join("\n")), setFromDraft(draft.id), requestAnimationFrame(() => (grow(), box.current?.focus())))} data-testid="dm-ai-use">
            Edit
          </button>
          <button type="button" className="ibx-btn on" disabled={busy} onClick={() => void send({ text: draft.bubbles.join("\n"), draftId: draft.id })} data-testid="dm-ai-send">
            Send
          </button>
          <button type="button" className="ibx-ib sm ghost" aria-label="Discard the draft" onClick={() => void discard(draft.id)}>
            <I name="i-x" />
          </button>
        </>
      )}
    </div>
  );

  const attach = async (f: File) => {
    if (!/^image\/(jpeg|png|gif)$/.test(f.type)) return toast.error("Instagram takes a JPG, PNG or GIF in a DM.");
    if (f.size > 8 * 1024 * 1024) return toast.error("Instagram takes images up to 8 MB in a DM.");
    const form = new FormData();
    form.append("file", f);
    setBusy(true);
    try {
      const r = await api.postForm<{ url: string }>(`/clients/${clientId}/dm/upload`, form);
      setPhoto({ url: r.url, name: f.name, preview: URL.createObjectURL(f) });
    } catch (e) {
      toast.fail("Could not upload the photo", e);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
      e.preventDefault();
      void send();
    }
  };

  if (state.kind === "viewer") {
    return (
      <div className={phone ? "ibx-pcomp" : "ibx-comp"}>
        <div className="ibx-closed" data-testid="dm-readonly">
          <I name="i-eye" />
          Read only. You are signed in as a viewer, so replies, tags and changes are for the team.
        </div>
      </div>
    );
  }
  if (state.kind === "reconnect") {
    return (
      <div className={phone ? "ibx-pcomp" : "ibx-comp"}>
        <div className="ibx-closed" data-testid="dm-reconnect-composer">
          <I name="i-lock" />
          Reconnect @{thread.accountHandle.replace(/^@/, "")} to reply. Old messages stay readable.
        </div>
      </div>
    );
  }
  if (state.kind === "closed") {
    return (
      <div className={phone ? "ibx-pcomp" : "ibx-comp"} data-testid="dm-window-closed">
        <div className="ibx-closed">
          <I name="i-lock" />
          Reply window closed
          <span className="send off" aria-hidden="true">
            <I name="i-send" />
            {!phone && "Send"}
          </span>
        </div>
        <div className="ibx-wfoot">
          <I name="i-clock" />
          {state.closedAgo
            ? `Closed ${state.closedAgo}. It opens again when ${name.split(" ")[0]} sends a message.`
            : `${name} has not messaged this account yet, so Instagram does not allow a reply.`}
        </div>
        {phone && (
          <div className="ibx-banner info ph">
            <I name="i-info" />
            <div className="bt">
              <b>Why you cannot reply</b>
              Instagram allows replies within 24 hours of the person's last message. When {name} writes again, the window opens for
              another 24 hours.
            </div>
          </div>
        )}
      </div>
    );
  }

  const foot = messenger
    ? "Messenger is reply only: answer people who wrote first. New conversations start on Messenger."
    : state.left
      ? `${state.left} left in the reply window`
      : "Through Zernio. Instagram takes a reply within 24 hours of their last message.";

  return (
    <div className={phone ? "ibx-pcomp" : "ibx-comp"}>
      {aiCard}
      {replyTo && (
        <div className="ibx-repl">
          <span className="grow">
            <b>Replying to {replyTo.direction === "in" ? name : "yourself"}</b>
            <span>{messageSummary(replyTo)}</span>
          </span>
          <button type="button" className="ibx-ib sm ghost" aria-label="Cancel reply" onClick={onCancelReply}>
            <I name="i-x" />
          </button>
        </div>
      )}
      {photo && (
        <div className="ibx-repl photo">
          <img src={photo.preview} alt="" />
          <span className="grow">
            <b>Photo</b>
            <span>{photo.name}</span>
          </span>
          <button type="button" className="ibx-ib sm ghost" aria-label="Remove photo" onClick={() => setPhoto(null)}>
            <I name="i-x" />
          </button>
        </div>
      )}
      <div className={phone ? "ibx-pbox" : "ibx-cbox"}>
        <span className="ibx-emojiwrap">
          <button type="button" className="ibx-ib" aria-label="Emoji" aria-expanded={emoji} onClick={() => setEmoji((v) => !v)}>
            <I name="i-smile" />
          </button>
          {emoji && (
            <EmojiPop
              onPick={(e) => {
                const el = box.current;
                const at = el?.selectionStart ?? text.length;
                setText((t) => t.slice(0, at) + e + t.slice(el?.selectionEnd ?? at));
                setEmoji(false);
                requestAnimationFrame(() => el?.focus());
              }}
              onClose={() => setEmoji(false)}
            />
          )}
        </span>
        <button
          type="button"
          className="ibx-ib"
          aria-label={native ? "Attach a photo" : "Photos need the Instagram connection through Torerone's Meta app"}
          title={native ? "Attach a photo" : "Photos need the Instagram connection through Torerone's Meta app"}
          disabled={!native || busy}
          onClick={() => file.current?.click()}
          data-testid="dm-attach"
        >
          <I name="i-image" />
        </button>
        {ai?.enabled && !ready && draft?.status !== "writing" && (
          <button type="button" className="ibx-ib" aria-label="Draft with AI" title="Draft with AI" disabled={asking || busy} onClick={() => void askAi()} data-testid="dm-ai-ask">
            <I name="i-spark" />
          </button>
        )}
        <input ref={file} type="file" accept="image/jpeg,image/png,image/gif" hidden onChange={(e) => (e.target.files?.[0] && void attach(e.target.files[0]), (e.target.value = ""))} />
        <textarea
          ref={box}
          className="tx"
          rows={1}
          value={text}
          maxLength={1000}
          placeholder={`Message ${name}`}
          aria-label={`Message ${name}`}
          enterKeyHint="send"
          onChange={(e) => (setText(e.target.value), !e.target.value && setFromDraft(null), grow())}
          onKeyDown={onKey}
          data-testid="dm-composer"
        />
        {phone ? (
          <button type="button" className="ibx-psend" aria-label="Send" disabled={busy || (!text.trim() && !photo)} onClick={() => void send()} data-testid="dm-send">
            <I name="i-send" />
          </button>
        ) : (
          <button type="button" className="ibx-send" disabled={busy || (!text.trim() && !photo)} onClick={() => void send()} data-testid="dm-send">
            <I name="i-send" />
            {busy ? "Sending…" : "Send"}
          </button>
        )}
      </div>
      <div className="ibx-wfoot">
        <I name={messenger ? "i-info" : "i-clock"} />
        <span className={state.left ? undefined : "plain"}>{foot}</span>
        {!phone && (
          <>
            <span className="grow" />
            Enter sends · Shift+Enter for a new line
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Details
// -----------------------------------------------------------------------------

const STAGE_TONE: Record<DmStage, string> = { new: "new", engaged: "engaged", qualify: "qualify", offer: "offer", link: "link", won: "won" };

function Details({
  phone = false,
  thread,
  activity,
  viewer,
  knownTags,
  onPatch,
  onPause,
  onConvo,
  ai = null,
  onAi,
}: {
  phone?: boolean;
  thread: DmThreadView;
  activity: DmThreadActivity | null;
  viewer: boolean;
  knownTags: string[];
  onPatch(body: Record<string, unknown>): void;
  onPause(pause: boolean): void;
  onConvo(s: ConvoState): void;
  ai?: ThreadAi | null;
  onAi?(body: { off?: boolean; resume?: true }): void;
}) {
  const c = thread.contact;
  // AI replies in this chat (F5): off for the account, off here, handed off, paused after a team reply, or on.
  const tai = thread.ai ?? { off: false, handoffAt: null, handoffReason: null, pausedUntil: null };
  const aiPaused = !!tai.pausedUntil && Date.parse(tai.pausedUntil) > Date.now();
  const aiState = !ai?.enabled
    ? { text: "Off for this account", short: "Off", cls: "t3" }
    : tai.off
      ? { text: "Off in this chat", short: "Off here", cls: "warnc" }
      : tai.handoffAt
        ? { text: "Handed to you", short: "Handed off", cls: "warnc" }
        : aiPaused
          ? { text: "Paused after your reply", short: "Paused", cls: "warnc" }
          : { text: ai.mode === "autopilot" ? "Answers on its own" : "Writes drafts", short: ai.mode === "autopilot" ? "On" : "Drafts", cls: "okc" };
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [notes, setNotes] = useState(c.notes ?? "");
  useEffect(() => setNotes(c.notes ?? ""), [c.id, c.notes]);
  const handle = atHandle(c);
  const rs = replyState(thread, false);
  const win = rs.kind === "open" ? (rs.left ? `${rs.left} left` : "Applied by Zernio") : rs.kind === "closed" ? "Closed" : "Reconnect first";
  const state = convoState(thread);

  const addTag = () => {
    const t = newTag.trim();
    if (t && !c.tags.includes(t)) onPatch({ tags: [...c.tags, t] });
    setNewTag("");
    setAdding(false);
  };

  const sec = (label: string, children: ReactNode) =>
    phone ? (
      <div className="ibx-field">
        <span className="ibx-flab">{label}</span>
        {children}
      </div>
    ) : (
      <div className="isec">
        <div className="lbl">{label}</div>
        {children}
      </div>
    );

  return (
    <div className={phone ? "ibx-det ph" : "ibx-det"} data-testid="dm-details">
      <div className="info-h">
        <Avatar contact={c} size={phone ? 72 : 56} win={windowOpen(thread)} />
        <b>{who(c)}</b>
        {handle && thread.platform === "instagram" && (
          <button type="button" className="ibx-link" onClick={() => void openExternal(`https://instagram.com/${handle.slice(1)}`)}>
            {handle}
            <I name="i-ext" />
          </button>
        )}
        <span className="ibx-ch wide">
          <Channel platform={thread.platform} label="" />
          {thread.platform === "facebook" ? "Messenger" : "Instagram"}
          {phone ? `, messaged @${thread.accountHandle.replace(/^@/, "")}` : ` · @${thread.accountHandle.replace(/^@/, "")}`}
        </span>
      </div>

      {rs.kind === "closed" && !phone && (
        <div className="isec ibx-expl">
          <b>Why you cannot reply</b>
          <p>{WHY_CLOSED_1}</p>
          <p>{WHY_CLOSED_2}</p>
        </div>
      )}

      {sec("Stage", <>
        {viewer ? (
          <div className="ibx-stgsel ro">
            <span className={`ibx-stage ${STAGE_TONE[c.stage]}`}>
              <span className="ibx-sdot" />
            </span>
            {DM_STAGE_LABEL[c.stage]}
          </div>
        ) : phone ? (
          <nav className="ibx-chips stg" aria-label="Stage">
            {STAGE_OPTIONS.map((s) => (
              <button key={s.id} type="button" className={`ibx-chip stg ${s.id}${c.stage === s.id ? " on" : ""}`} aria-pressed={c.stage === s.id} onClick={() => onPatch({ stage: s.id })}>
                <span className="ibx-sdot" />
                {s.label}
              </button>
            ))}
          </nav>
        ) : (
          <label className="ibx-stgsel">
            <span className={`ibx-stage ${STAGE_TONE[c.stage]}`}>
              <span className="ibx-sdot" />
            </span>
            <select value={c.stage} onChange={(e) => onPatch({ stage: e.target.value })} aria-label="Stage" data-testid="dm-stage">
              {STAGE_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <I name="i-chev" />
          </label>
        )}
      </>)}

      {sec("Status", <>
        <div className={phone ? "mb-card ibx-grp" : "ibx-grp"}>
          <div className={phone ? "ibx-optrow" : "kv"}>
            {phone ? (
              <span className="lt">
                <b>Auto replies</b>
                <small>Automations and AI answer this person on their own</small>
              </span>
            ) : (
              <span>Auto replies</span>
            )}
            {viewer ? (
              <b className={thread.pausedAt ? "warnc" : "okc"}>{thread.pausedAt ? "Paused" : "On"}</b>
            ) : (
              <span className="row">
                {!phone && <b className={thread.pausedAt ? "warnc" : "okc"}>{thread.pausedAt ? "Paused" : "On"}</b>}
                <button type="button" role="switch" aria-checked={!thread.pausedAt} aria-label="Auto replies" className="ibx-togbtn" onClick={() => onPause(!thread.pausedAt)} data-testid="dm-auto-toggle">
                  <span className={`ibx-tog${thread.pausedAt ? "" : " on"}`} aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
          <div className={phone ? "ibx-optrow col" : "kv"}>
            {phone ? (
              <span className="lt">
                <b>Conversation</b>
              </span>
            ) : (
              <span>Conversation</span>
            )}
            {viewer ? (
              <b>{CONVO_LABEL[state]}</b>
            ) : phone ? (
              <div className="ibx-seg ph" role="radiogroup" aria-label="Conversation">
                {CONVO_STATES.map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={state === s} className={state === s ? "on" : undefined} onClick={() => onConvo(s)}>
                    {CONVO_LABEL[s]}
                  </button>
                ))}
              </div>
            ) : (
              <label className="ibx-btn sm ibx-pick">
                <select value={state} onChange={(e) => onConvo(e.target.value as ConvoState)} aria-label="Conversation" data-testid="dm-convo">
                  {CONVO_STATES.map((s) => (
                    <option key={s} value={s}>
                      {CONVO_LABEL[s]}
                    </option>
                  ))}
                </select>
                <I name="i-chev" />
              </label>
            )}
          </div>
          <div className={phone ? "ibx-optrow" : "kv"}>
            {phone ? (
              <span className="lt">
                <b>Reply window</b>
                <small>Instagram allows replies for 24 hours after their last message</small>
              </span>
            ) : (
              <span>Reply window</span>
            )}
            <b className={rs.kind === "open" && rs.left ? "okc" : rs.kind === "closed" ? "badc" : undefined}>{win}</b>
          </div>
          {ai && (
            <div className={phone ? "ibx-optrow" : "kv"} data-testid="dm-ai-row">
              {phone ? (
                <span className="lt">
                  <b>AI replies</b>
                  <small>{aiState.text}{tai.handoffReason && tai.handoffAt ? `: ${tai.handoffReason}` : ""}</small>
                </span>
              ) : (
                <span>AI replies</span>
              )}
              <span className="row">
                {!phone && <b className={aiState.cls} title={[aiState.text, tai.handoffAt ? tai.handoffReason : null].filter(Boolean).join(": ")}>{aiState.short}</b>}
                {!viewer && ai.enabled && (tai.handoffAt || aiPaused) && onAi ? (
                  <button type="button" className="ibx-btn sm" onClick={() => onAi({ resume: true })} data-testid="dm-ai-resume">
                    {phone ? "Answer again" : "Resume"}
                  </button>
                ) : (
                  !viewer &&
                  ai.enabled &&
                  onAi && (
                    <button type="button" role="switch" aria-checked={!tai.off} aria-label="AI replies in this chat" className="ibx-togbtn" onClick={() => onAi({ off: !tai.off })} data-testid="dm-ai-toggle">
                      <span className={`ibx-tog${tai.off ? "" : " on"}`} aria-hidden="true" />
                    </button>
                  )
                )}
              </span>
            </div>
          )}
        </div>
      </>)}

      {sec("Tags", <>
        <div className="ibx-tags">
          {c.tags.map((t) => (
            <span key={t} className="ibx-tag">
              {t}
              {!viewer && (
                <button type="button" className="x" aria-label={`Remove ${t}`} onClick={() => onPatch({ tags: c.tags.filter((x) => x !== t) })}>
                  <I name="i-x" />
                </button>
              )}
            </span>
          ))}
          {!c.tags.length && viewer && <span className="t3">No tags</span>}
          {!viewer &&
            (adding ? (
              <span className="ibx-tag add editing">
                <input
                  autoFocus
                  value={newTag}
                  maxLength={40}
                  list="ibx-known-tags"
                  aria-label="New tag"
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag();
                    if (e.key === "Escape") (setAdding(false), setNewTag(""));
                  }}
                  onBlur={addTag}
                />
                <datalist id="ibx-known-tags">
                  {knownTags.filter((t) => !c.tags.includes(t)).map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </span>
            ) : (
              <button type="button" className="ibx-tag add" onClick={() => setAdding(true)} data-testid="dm-add-tag">
                + Add tag
              </button>
            ))}
        </div>
      </>)}

      {sec("Notes", <>
        {viewer ? (
          <p className="ibx-notes ro">{c.notes || "No notes"}</p>
        ) : (
          <textarea
            className="ibx-notes"
            value={notes}
            maxLength={4000}
            rows={3}
            placeholder="What the team should know about this person"
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (c.notes ?? "") && onPatch({ notes: notes.trim() ? notes : null })}
            data-testid="dm-notes"
          />
        )}
      </>)}

      {sec("Activity", <>
        <div className={phone ? "mb-card list ibx-act" : "ibx-act"}>
          {ai?.note && (
            <div className={phone ? "mb-lrow" : "kv"}>
              <span>AI note</span>
              <b>{ai.note}</b>
            </div>
          )}
          <div className={phone ? "mb-lrow" : "kv"}>
            <span>Messages</span>
            <b>{activity ? activity.messages : "…"}</b>
          </div>
          {activity?.cameFrom && (
            <div className={phone ? "mb-lrow" : "kv"}>
              <span>Came from</span>
              <b>{activity.cameFrom}</b>
            </div>
          )}
          <div className={phone ? "mb-lrow" : "kv"}>
            <span>Last message</span>
            <b>{c.lastSeenAt ? ago(c.lastSeenAt) : thread.lastMessageAt ? ago(thread.lastMessageAt) : "None yet"}</b>
          </div>
          <div className={phone ? "mb-lrow" : "kv"}>
            <span>First seen</span>
            <b>{activity?.firstSeenAt ? shortDate(activity.firstSeenAt) : "…"}</b>
          </div>
        </div>
      </>)}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Empty and error (mockup 10, states c and d)
// -----------------------------------------------------------------------------

function NoConversations({ phone, handle }: { phone: boolean; handle: string }) {
  return (
    <section className={phone ? "mb-card ibx-empty" : "card glass ibx-empty"} data-testid="dm-empty">
      <span className="ei">
        <I name="i-inbox" />
      </span>
      <h3>No conversations yet</h3>
      <p>When someone DMs @{handle.replace(/^@/, "")}, it shows up here within a few seconds. Comment-to-DM automations start conversations too.</p>
      <div className="acts">
        <button type="button" className={phone ? "mb-btn block" : "btn"} onClick={() => navigate("workflows", "automations")}>
          <I name="i-bolt" />
          Create an automation
        </button>
        {!phone && (
          <button type="button" className="btn ghost" onClick={() => navigate("workflows", "automations")}>
            Set a welcome message
          </button>
        )}
      </div>
    </section>
  );
}

function CouldNotLoad({ phone, lastLoaded, onRetry }: { phone: boolean; lastLoaded: Date | null; onRetry(): void }) {
  return (
    <section className={phone ? "mb-card ibx-empty" : "card glass ibx-empty"} role="alert" data-testid="dm-inbox.error">
      <span className="ei bad">
        <I name="i-wifi-off" />
      </span>
      <h3>Could not load the Inbox</h3>
      <p>Toreroflow could not reach its server. Messages are safe on Instagram and Messenger, and will show here once it is back.</p>
      <div className="acts">
        <button type="button" className={phone ? "mb-btn block" : "btn"} onClick={onRetry} data-testid="dm-retry">
          <I name="i-refresh" />
          Retry
        </button>
      </div>
      <p className="help">
        Trying again on its own every 15 seconds.{lastLoaded ? ` Last loaded ${clock(lastLoaded)}.` : ""}
      </p>
    </section>
  );
}
