import { useCallback, useEffect, useRef, useState } from "react";
import { DM_STAGE_LABEL, type DmContactRow, type DmStage } from "@toreroflow/core";
import { api, type ClientSummary } from "../../lib/api";
import {
  ago,
  atHandle,
  CONTACT_SORTS,
  contactQuery,
  csvField,
  NO_CONTACT_FILTERS,
  previewLine,
  replyState,
  shortDate,
  STAGE_OPTIONS,
  who,
  type ContactFilters,
} from "../../lib/inbox";
import { useIsPhone } from "../../lib/phone";
import { useAppState } from "../../state/AppState";
import { Sheet } from "../analytics/phoneBits";
import { useToast } from "../Toasts";
import { Avatar, Channel, I, Stage } from "./parts";
import "./inbox.css";

/*
 * Contacts (F3, mockups round 2 04-contacts, desktop and phone with the
 * filter, actions and select sheets). Everyone who has messaged the brand on
 * Instagram or Messenger: search, stage, tag, channel and unread filters, a
 * person panel, and select mode for one stage or tag change on many people
 * (POST /dm/contacts/bulk). Viewers read; the write controls are not drawn.
 */

interface ListResp {
  contacts: DmContactRow[];
  nextCursor: string | null;
  total: number;
  counts: { all: number; unread: number };
  tags: Array<{ name: string; count: number }>;
}

type TagSheet = { ids: string[]; current: string[] } | null;

export default function Contacts({ client, onOpenThread }: { client: ClientSummary; onOpenThread(threadId: string): void }) {
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const isPhone = useIsPhone();
  const toast = useToast();
  const [filters, setFilters] = useState<ContactFilters>(NO_CONTACT_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<DmContactRow | null>(null);
  const [tagSheet, setTagSheet] = useState<TagSheet>(null);
  const [stageSheet, setStageSheet] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = client.accounts.filter((a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"));

  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText })), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await api.get<ListResp>(`/clients/${client.id}/dm/contacts${contactQuery(filters)}`);
      if (n !== seq.current) return;
      setData(r);
      setErr(null);
    } catch (e) {
      if (n === seq.current) setErr(e instanceof Error ? e.message : "could not load contacts");
    }
  }, [client.id, filters]);
  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!data?.nextCursor) return;
    try {
      const r = await api.get<ListResp>(`/clients/${client.id}/dm/contacts${contactQuery(filters, data.nextCursor)}`);
      setData((d) => (d ? { ...r, contacts: [...d.contacts, ...r.contacts] } : r));
    } catch (e) {
      toast.fail("Could not load more contacts", e);
    }
  };

  const contacts = data?.contacts ?? [];
  const person = contacts.find((c) => c.id === focus) ?? (!isPhone ? contacts[0] : undefined) ?? null;
  const tags = data?.tags ?? [];

  const replace = (c: DmContactRow) => setData((d) => (d ? { ...d, contacts: d.contacts.map((x) => (x.id === c.id ? c : x)) } : d));
  const patchOne = async (c: DmContactRow, body: { stage?: DmStage; tags?: string[] }) => {
    try {
      const r = await api.patch<{ contact: DmContactRow }>(`/clients/${client.id}/dm/contacts/${c.id}`, body);
      replace(r.contact);
      if (body.tags) void load();
    } catch (e) {
      toast.fail("Could not save that change", e);
    }
  };
  const bulk = async (ids: string[], body: { stage?: DmStage; addTags?: string[]; removeTags?: string[] }, done: string) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.post(`/clients/${client.id}/dm/contacts/bulk`, { ids, ...body });
      toast.success(done);
      await load();
    } catch (e) {
      toast.fail("Could not change those contacts", e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clearPick = () => (setPicked(new Set()), setSelecting(false));

  const exportCsv = async () => {
    setBusy(true);
    try {
      const all: DmContactRow[] = [];
      let cursor: string | null = null;
      // ponytail: 100 pages of 50 is the cap; a server-side CSV if a brand ever has more.
      for (let page = 0; page < 100; page++) {
        const r: ListResp = await api.get<ListResp>(`/clients/${client.id}/dm/contacts${contactQuery(filters, cursor)}`);
        all.push(...r.contacts);
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      const rows = [
        ["Name", "Username", "Channel", "Account", "Stage", "Tags", "Last message", "Last message at", "First seen", "Notes"],
        ...all.map((c) => [
          who(c),
          c.handle ?? "",
          c.platform === "facebook" ? "Messenger" : "Instagram",
          c.accountHandle,
          DM_STAGE_LABEL[c.stage],
          c.tags.join("; "),
          c.lastPreview ?? "",
          c.lastMessageAt ?? "",
          c.firstSeenAt.slice(0, 10),
          c.notes ?? "",
        ]),
      ];
      const csv = rows.map((r) => r.map(csvField).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.fail("Could not export the contacts", e);
    } finally {
      setBusy(false);
    }
  };

  const copyHandle = (c: DmContactRow) =>
    void navigator.clipboard.writeText(atHandle(c) ?? who(c)).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    );

  const views = (
    <>
      <button type="button" className={`ibx-chip${!filters.tag && !filters.unread ? " on" : ""}`} aria-pressed={!filters.tag && !filters.unread} onClick={() => setFilters({ ...filters, tag: null, unread: false })}>
        All <small>{data?.counts.all ?? ""}</small>
      </button>
      <button type="button" className={`ibx-chip${filters.unread ? " on" : ""}`} aria-pressed={filters.unread} onClick={() => setFilters({ ...filters, unread: !filters.unread, tag: null })} data-testid="contacts-unread">
        Unread <small>{data?.counts.unread ?? ""}</small>
      </button>
      {tags.map((t) => (
        <button key={t.name} type="button" className={`ibx-chip${filters.tag === t.name ? " on" : ""}`} aria-pressed={filters.tag === t.name} onClick={() => setFilters({ ...filters, tag: filters.tag === t.name ? null : t.name, unread: false })}>
          {!isPhone && <I name="i-tag" />}
          {t.name} <small>{t.count}</small>
        </button>
      ))}
    </>
  );

  const sheets = (
    <>
      {filterOpen && (
        <ContactFilterSheet filters={filters} onApply={(f) => (setFilters(f), setFilterOpen(false))} onClose={() => setFilterOpen(false)} />
      )}
      {actionsFor && (
        <Sheet label={who(actionsFor)} title={<span className="vh">{who(actionsFor)}</span>} onClose={() => setActionsFor(null)} className="cts-sheet" testId="contacts-actions"
          foot={
            <button type="button" className="mb-btn ghost block" onClick={() => setActionsFor(null)}>
              Cancel
            </button>
          }
        >
          <div className="cts-subject">
            <Avatar contact={actionsFor} size={44} />
            <span className="t">
              <b>{who(actionsFor)}</b>
              <small>
                {atHandle(actionsFor) ?? "Messenger"} on {actionsFor.platform === "facebook" ? "Messenger" : "Instagram"}, first seen {shortDate(actionsFor.firstSeenAt)}
              </small>
            </span>
          </div>
          <div className="mb-card list">
            {actionsFor.threadId && (
              <button type="button" className="mb-lrow" onClick={() => (onOpenThread(actionsFor.threadId!), setActionsFor(null))}>
                <I name="i-comment" />
                <span className="mb-lt">
                  <b>Open the chat</b>
                </span>
              </button>
            )}
            {!viewer && (
              <>
                <button type="button" className="mb-lrow" onClick={() => (setTagSheet({ ids: [actionsFor.id], current: actionsFor.tags }), setActionsFor(null))}>
                  <I name="i-tag" />
                  <span className="mb-lt">
                    <b>Tags</b>
                    <small>{actionsFor.tags.join(", ") || "No tags"}</small>
                  </span>
                </button>
                <button type="button" className="mb-lrow" onClick={() => (setStageSheet([actionsFor.id]), setActionsFor(null))}>
                  <I name="i-target" />
                  <span className="mb-lt">
                    <b>Stage</b>
                    <small>{DM_STAGE_LABEL[actionsFor.stage]}</small>
                  </span>
                </button>
              </>
            )}
            <button type="button" className="mb-lrow" onClick={() => (copyHandle(actionsFor), setActionsFor(null))}>
              <I name="i-copy" />
              <span className="mb-lt">
                <b>Copy username</b>
              </span>
            </button>
          </div>
        </Sheet>
      )}
      {tagSheet && (
        <TagPickSheet
          phone={isPhone}
          tags={tags.map((t) => t.name)}
          current={tagSheet.current}
          many={tagSheet.ids.length > 1}
          onClose={() => setTagSheet(null)}
          onApply={(add, remove) => {
            const ids = tagSheet.ids;
            setTagSheet(null);
            void bulk(ids, { ...(add.length ? { addTags: add } : {}), ...(remove.length ? { removeTags: remove } : {}) }, `Tags changed for ${ids.length === 1 ? "1 person" : `${ids.length} people`}`).then(clearPick);
          }}
        />
      )}
      {stageSheet && (
        <Sheet label="Set stage" title="Stage" sub={stageSheet.length > 1 ? `For ${stageSheet.length} people` : undefined} onClose={() => setStageSheet(null)} className="cts-sheet" testId="contacts-stage">
          <div className="mb-card list">
            {STAGE_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="mb-lrow"
                onClick={() => {
                  const ids = stageSheet;
                  setStageSheet(null);
                  void bulk(ids, { stage: s.id }, `${ids.length === 1 ? "1 person" : `${ids.length} people`} moved to ${s.label}`).then(clearPick);
                }}
              >
                <Stage stage={s.id} dot />
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );

  if (err && !data) {
    return (
      <div className={`cts-wrap ibx-wrap${isPhone ? " ph" : ""}`} data-testid="contacts" data-state="error">
        <section className={isPhone ? "mb-card ibx-empty" : "card glass ibx-empty"} role="alert">
          <span className="ei bad">
            <I name="i-wifi-off" />
          </span>
          <h3>Could not load contacts</h3>
          <p>{err}</p>
          <div className="acts">
            <button type="button" className={isPhone ? "mb-btn block" : "btn"} onClick={() => void load()}>
              <I name="i-refresh" />
              Retry
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (data && data.counts.all === 0) {
    return (
      <div className={`cts-wrap ibx-wrap${isPhone ? " ph" : ""}`} data-testid="contacts" data-state="empty">
        <section className={isPhone ? "mb-card ibx-empty" : "card glass ibx-empty"}>
          <span className="ei">
            <I name="i-users" />
          </span>
          <h3>No contacts yet</h3>
          <p>
            Everyone who messages {client.name} on Instagram or Messenger shows up here, with their stage and tags. Open the Inbox to see
            conversations as they come in.
          </p>
        </section>
      </div>
    );
  }

  if (isPhone) {
    const selMode = selecting || picked.size > 0;
    return (
      <div className="cts-wrap ibx-wrap ph" data-testid="contacts" data-state={data ? "ready" : "loading"}>
        <div className="ibx-ctl">
          <label className="ibx-input round">
            <I name="i-search" />
            <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search name or @username" aria-label="Search contacts" data-testid="contacts-search" />
          </label>
          <button type="button" className={`mb-ib${filters.stages.length || filters.platform || filters.sort !== "last" ? " on" : ""}`} aria-label="Filter by stage, channel and tag" onClick={() => setFilterOpen(true)} data-testid="contacts-filter">
            <I name="i-filter" />
          </button>
        </div>
        <nav className="ibx-chips accs cts-tagchips" aria-label="Tags">
          {views}
        </nav>
        <div className="ibx-metarow cts-rowsb">
          <span>{data ? `${data.total} contacts` : "Loading"}</span>
          {!viewer && (
            <button type="button" className="mb-btn sm ghost" onClick={() => (selMode ? clearPick() : setSelecting(true))} data-testid="contacts-select">
              {selMode ? "Done" : "Select"}
            </button>
          )}
        </div>
        <section className={`mb-card list ibx-list cts-list${selMode ? " selecting" : ""}`} aria-label="Contacts">
          {contacts.map((c) => (
            <ContactRowPhone
              key={c.id}
              c={c}
              selMode={selMode}
              picked={picked.has(c.id)}
              onTap={() => (selMode ? toggle(c.id) : c.threadId ? onOpenThread(c.threadId) : setActionsFor(c))}
              onHold={() => (viewer ? setActionsFor(c) : selMode ? toggle(c.id) : setActionsFor(c))}
            />
          ))}
          {!contacts.length && data && <p className="ibx-nomatch">Nobody matches these filters.</p>}
          {data?.nextCursor && (
            <button type="button" className="ibx-showmore" onClick={() => void more()}>
              Show more
              <I name="i-chev" />
            </button>
          )}
        </section>
        <p className="ibx-foot">Press and hold a person for tags, stage and more.</p>
        {selMode && !viewer && (
          <div className="cts-selbar" data-testid="contacts-selbar">
            <b>{picked.size} selected</b>
            <button type="button" className="mb-btn sm" disabled={!picked.size || busy} onClick={() => setTagSheet({ ids: [...picked], current: [] })}>
              <I name="i-tag" />
              Tag
            </button>
            <button type="button" className="mb-btn sm" disabled={!picked.size || busy} onClick={() => setStageSheet([...picked])}>
              Stage
            </button>
            <button type="button" className="mb-ib" aria-label="Done selecting" onClick={clearPick}>
              <I name="i-x" />
            </button>
          </div>
        )}
        {sheets}
      </div>
    );
  }

  const allPicked = contacts.length > 0 && contacts.every((c) => picked.has(c.id));
  return (
    <div className="cts-wrap ibx-wrap" data-testid="contacts" data-state={data ? "ready" : "loading"}>
      <div className="cts-top">
        <div className="cts-views ibx-chips scroll" aria-label="Saved views and tags">
          {views}
        </div>
        <label className="ibx-btn ibx-pick cts-acc">
          <span className="vh">Account</span>
          <select value={filters.accountId ?? ""} onChange={(e) => setFilters({ ...filters, accountId: e.target.value || null })} data-testid="contacts-account">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.platform === "facebook" ? "Messenger" : `@${a.handle.replace(/^@/, "")}`}
              </option>
            ))}
          </select>
          <I name="i-chev" />
        </label>
        <button type="button" className="ibx-btn ghost cts-export" disabled={busy || !data?.total} onClick={() => void exportCsv()} data-testid="contacts-export">
          <I name="i-dl" />
          Export CSV
        </button>
      </div>

      <div className="cts-grid">
        <section className="cts-card" aria-label="Contacts">
          {picked.size > 0 && !viewer ? (
            <div className="cts-bulk" data-testid="contacts-bulk">
              <b>{picked.size} selected</b>
              <button type="button" className="ibx-btn sm" disabled={busy} onClick={() => setTagSheet({ ids: [...picked], current: [] })}>
                <I name="i-tag" />
                Tags
              </button>
              <label className="ibx-btn sm ibx-pick">
                <select value="" disabled={busy} onChange={(e) => e.target.value && void bulk([...picked], { stage: e.target.value as DmStage }, `${picked.size} moved to ${DM_STAGE_LABEL[e.target.value as DmStage]}`).then(clearPick)} aria-label="Set stage">
                  <option value="">Set stage</option>
                  {STAGE_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <I name="i-chev" />
              </label>
              <span className="grow" />
              <button type="button" className="ibx-btn sm ghost" onClick={clearPick}>
                Clear
              </button>
            </div>
          ) : (
            <div className="cts-tool">
              <label className="ibx-input round">
                <I name="i-search" />
                <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search name or @username" aria-label="Search contacts" data-testid="contacts-search" />
              </label>
              <span className="grow" />
              <label className="ibx-btn ibx-pick">
                <select value={filters.stages[0] ?? ""} onChange={(e) => setFilters({ ...filters, stages: e.target.value ? [e.target.value as DmStage] : [] })} aria-label="Stage" data-testid="contacts-stage-filter">
                  <option value="">Stage: any</option>
                  {STAGE_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>
                      Stage: {s.label}
                    </option>
                  ))}
                </select>
                <I name="i-chev" />
              </label>
              <label className="ibx-btn ibx-pick">
                <select value={filters.platform ?? ""} onChange={(e) => setFilters({ ...filters, platform: (e.target.value || null) as ContactFilters["platform"] })} aria-label="Channel">
                  <option value="">Channel: all</option>
                  <option value="instagram">Channel: Instagram</option>
                  <option value="facebook">Channel: Messenger</option>
                </select>
                <I name="i-chev" />
              </label>
            </div>
          )}
          <div className="cts-scroll">
            <table className="cts-table">
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: "30%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "18%" }} />
                <col />
                <col style={{ width: 84 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    {!viewer && contacts.length > 0 && (
                      <button type="button" role="checkbox" aria-checked={allPicked} aria-label="Select everyone shown" className={`cts-check${allPicked ? " on" : ""}${picked.size ? " vis" : ""}`} onClick={() => setPicked(allPicked ? new Set() : new Set(contacts.map((c) => c.id)))}>
                        {allPicked && <I name="i-check" />}
                      </button>
                    )}
                  </th>
                  <th>Name</th>
                  <th>Stage</th>
                  <th>Tags</th>
                  <th>Last message</th>
                  <th>First seen</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr
                    key={c.id}
                    className={person?.id === c.id ? "is-sel" : undefined}
                    onClick={() => setFocus(c.id)}
                    onDoubleClick={() => c.threadId && onOpenThread(c.threadId)}
                    data-testid={`contact-${c.id}`}
                  >
                    <td>
                      {!viewer && (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={picked.has(c.id)}
                          aria-label={`Select ${who(c)}`}
                          className={`cts-check${picked.has(c.id) ? " on" : ""}${picked.size ? " vis" : ""}`}
                          onClick={(e) => (e.stopPropagation(), toggle(c.id))}
                        >
                          {picked.has(c.id) && <I name="i-check" />}
                        </button>
                      )}
                    </td>
                    <td>
                      <button type="button" className="cts-who" onClick={(e) => (e.stopPropagation(), setFocus(c.id))} aria-label={`Show ${who(c)}`}>
                        <Avatar contact={c} size={32} />
                        <span className="t">
                          <b>{who(c)}</b>
                          <small>
                            <Channel platform={c.platform} label="" />
                            {c.platform === "facebook" ? "Messenger" : (atHandle(c) ?? c.accountHandle)}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <Stage stage={c.stage} dot />
                    </td>
                    <td>
                      {c.tags.length ? (
                        <span className="cts-tags">
                          <span className="cts-tg">{c.tags[0]}</span>
                          {c.tags.length > 1 && <span className="cts-tg">+{c.tags.length - 1}</span>}
                        </span>
                      ) : (
                        <span className="t3">No tags</span>
                      )}
                    </td>
                    <td>
                      <span className="cts-lm">
                        <span className={c.unread ? "unread" : undefined}>{previewLine(c)}</span>
                        <small>{ago(c.lastMessageAt)}</small>
                      </span>
                    </td>
                    <td className="t3">{shortDate(c.firstSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!contacts.length && data && <p className="ibx-nomatch">Nobody matches these filters.</p>}
            {!data && <p className="ibx-nomatch">Loading contacts…</p>}
          </div>
          <div className="cts-foot">
            <span>
              Showing {contacts.length} of {data?.total ?? 0}. Click a row to see the person, double-click to open the chat.
            </span>
            {data?.nextCursor && (
              <button type="button" className="ibx-btn sm ghost" onClick={() => void more()}>
                Load more
              </button>
            )}
          </div>
        </section>

        {person && (
          <aside className="cts-card cts-person" aria-label={who(person)} data-testid="contacts-person">
            <div className="hd">
              <Avatar contact={person} size={56} />
              <b>{who(person)}</b>
              <small>
                <Channel platform={person.platform} label="" />
                {person.platform === "facebook" ? `Messenger, via ${person.accountHandle}` : `${atHandle(person) ?? "Instagram user"} on Instagram`}
              </small>
            </div>
            <div className="grp">
              <span className="flab">Stage</span>
              {viewer ? (
                <Stage stage={person.stage} dot />
              ) : (
                <label className="ibx-stgsel">
                  <span className={`ibx-stage ${person.stage}`}>
                    <span className="ibx-sdot" />
                  </span>
                  <select value={person.stage} onChange={(e) => void patchOne(person, { stage: e.target.value as DmStage })} aria-label="Stage">
                    {STAGE_OPTIONS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <I name="i-chev" />
                </label>
              )}
            </div>
            <div className="grp">
              <span className="flab">Tags</span>
              <PersonTags person={person} viewer={viewer} known={tags.map((t) => t.name)} onSet={(next) => void patchOne(person, { tags: next })} />
            </div>
            <div className="grp">
              <div className="kv">
                <span>Reply window</span>
                <b>{personWindow(person)}</b>
              </div>
              <div className="kv">
                <span>Last message</span>
                <b>{person.lastMessageAt ? ago(person.lastMessageAt) : "None yet"}</b>
              </div>
              <div className="kv">
                <span>Unread</span>
                <b>{person.unread}</b>
              </div>
              <div className="kv">
                <span>First seen</span>
                <b>{shortDate(person.firstSeenAt)}</b>
              </div>
            </div>
            {person.threadId && (
              <button type="button" className="btn pri cts-open" onClick={() => onOpenThread(person.threadId!)} data-testid="contacts-open">
                <I name="i-comment" />
                Open conversation
              </button>
            )}
            <div className="quiet">
              <button type="button" className="cts-lnk" onClick={() => copyHandle(person)}>
                Copy username
              </button>
            </div>
          </aside>
        )}
      </div>
      {sheets}
    </div>
  );
}

const personWindow = (p: DmContactRow): string => {
  if (!p.threadId) return "No conversation";
  const s = replyState({ source: p.windowEndsAt !== null ? "native" : "zernio", canReply: true, windowEndsAt: p.windowEndsAt }, false);
  if (s.kind === "open") return s.left ? `${s.left} left` : "Applied by Zernio";
  return "Closed";
};

function PersonTags({ person, viewer, known, onSet }: { person: DmContactRow; viewer: boolean; known: string[]; onSet(tags: string[]): void }) {
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState("");
  const add = () => {
    const t = v.trim();
    if (t && !person.tags.includes(t)) onSet([...person.tags, t]);
    setV("");
    setAdding(false);
  };
  return (
    <div className="ibx-tags">
      {person.tags.map((t) => (
        <span key={t} className="ibx-tag">
          {t}
          {!viewer && (
            <button type="button" className="x" aria-label={`Remove ${t}`} onClick={() => onSet(person.tags.filter((x) => x !== t))}>
              <I name="i-x" />
            </button>
          )}
        </span>
      ))}
      {!person.tags.length && viewer && <span className="t3">No tags</span>}
      {!viewer &&
        (adding ? (
          <span className="ibx-tag add editing">
            <input
              autoFocus
              value={v}
              maxLength={40}
              list="cts-known-tags"
              aria-label="New tag"
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") (setAdding(false), setV(""));
              }}
              onBlur={add}
            />
            <datalist id="cts-known-tags">
              {known.filter((t) => !person.tags.includes(t)).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </span>
        ) : (
          <button type="button" className="ibx-tag add" onClick={() => setAdding(true)}>
            Add tag
          </button>
        ))}
    </div>
  );
}

function ContactRowPhone({ c, selMode, picked, onTap, onHold }: { c: DmContactRow; selMode: boolean; picked: boolean; onTap(): void; onHold(): void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const cancel = () => timer.current && (clearTimeout(timer.current), (timer.current = null));
  return (
    <button
      type="button"
      className={`ibx-crow cts-crow${c.unread ? " unread" : ""}${picked ? " picked" : ""}`}
      aria-pressed={selMode ? picked : undefined}
      onPointerDown={() => {
        held.current = false;
        timer.current = window.setTimeout(() => {
          held.current = true;
          timer.current = null;
          onHold();
        }, 450);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => (held.current ? (held.current = false) : onTap())}
      data-testid={`contact-${c.id}`}
    >
      {selMode && <span className={`cts-check${picked ? " on" : ""}`}>{picked && <I name="i-check" />}</span>}
      <Avatar contact={c} size={44} />
      <span className="grow">
        <span className="l1">
          <span className="who">{who(c)}</span>
          <Channel platform={c.platform} label={c.platform === "facebook" ? "Msgr" : "IG"} />
          <span className="when">{ago(c.lastMessageAt)}</span>
        </span>
        <span className="l2">
          <Stage stage={c.stage} dot />
          <span className="pv">{previewLine(c)}</span>
        </span>
      </span>
    </button>
  );
}

function ContactFilterSheet({ filters, onApply, onClose }: { filters: ContactFilters; onApply(f: ContactFilters): void; onClose(): void }) {
  const [f, setF] = useState(filters);
  return (
    <Sheet
      label="Filter contacts"
      title="Filter"
      onClose={onClose}
      className="cts-sheet"
      testId="contacts-filter-sheet"
      foot={
        <>
          <button type="button" className="mb-btn ghost" onClick={() => onApply({ ...f, stages: [], platform: null, sort: "last" })}>
            Reset
          </button>
          <button type="button" className="mb-btn pri" onClick={() => onApply(f)}>
            Show contacts
          </button>
        </>
      }
    >
      <div className="ibx-field">
        <span className="ibx-flab">Stage</span>
        <div className="ibx-wchips">
          {STAGE_OPTIONS.map((s) => {
            const on = f.stages.includes(s.id);
            return (
              <button key={s.id} type="button" className={`mb-chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setF({ ...f, stages: on ? f.stages.filter((x) => x !== s.id) : [...f.stages, s.id] })}>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
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
      <div className="ibx-field">
        <span className="ibx-flab">Sort by</span>
        <div className="mb-card list" role="radiogroup" aria-label="Sort by">
          {CONTACT_SORTS.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={f.sort === s.id} className="ibx-optrow" onClick={() => setF({ ...f, sort: s.id })}>
              <span className={`cts-radio${f.sort === s.id ? " on" : ""}`} aria-hidden="true" />
              <span className="lt">
                <b>{s.label}</b>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** Tags for one person or many: tick the existing ones, or type a new one. */
function TagPickSheet({ phone, tags, current, many, onApply, onClose }: { phone: boolean; tags: string[]; current: string[]; many: boolean; onApply(add: string[], remove: string[]): void; onClose(): void }) {
  // Many people: each tag is add, remove or leave. One person: ticked or not.
  const [want, setWant] = useState<Record<string, "add" | "remove" | undefined>>({});
  const [v, setV] = useState("");
  const all = [...new Set([...tags, ...current, ...Object.keys(want)])].sort();
  const isOn = (t: string) => (want[t] ? want[t] === "add" : current.includes(t));
  const flip = (t: string) =>
    setWant((w) => {
      const next = { ...w };
      if (many) next[t] = w[t] === "add" ? "remove" : w[t] === "remove" ? undefined : "add";
      else next[t] = isOn(t) ? (current.includes(t) ? "remove" : undefined) : current.includes(t) ? undefined : "add";
      return next;
    });
  const apply = () => {
    const add = Object.entries(want).filter(([, x]) => x === "add").map(([t]) => t);
    const remove = Object.entries(want).filter(([, x]) => x === "remove").map(([t]) => t);
    if (add.length || remove.length) onApply(add, remove);
    else onClose();
  };
  const body = (
    <>
      {many && <p className="ibx-minfo">Tap a tag once to add it to everyone selected, twice to remove it from them.</p>}
      <div className="ibx-wchips">
        {all.map((t) => (
          <button key={t} type="button" className={`${phone ? "mb-chip" : "ibx-chip"}${isOn(t) ? " on" : ""}${want[t] === "remove" ? " rm" : ""}`} aria-pressed={isOn(t)} onClick={() => flip(t)}>
            {want[t] === "remove" ? `Remove ${t}` : t}
          </button>
        ))}
      </div>
      <label className={phone ? "ibx-field" : "cts-newtag"}>
        <span className="ibx-flab">New tag</span>
        <input
          className={phone ? "mb-input" : "ibx-notes cts-taginput"}
          value={v}
          maxLength={40}
          placeholder="e.g. vip"
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v.trim()) (setWant((w) => ({ ...w, [v.trim()]: "add" })), setV(""));
          }}
        />
      </label>
    </>
  );
  if (phone) {
    return (
      <Sheet label="Tags" title="Tags" sub={many ? "For everyone selected" : undefined} onClose={onClose} className="cts-sheet" testId="contacts-tags"
        foot={
          <>
            <button type="button" className="mb-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="mb-btn pri" onClick={apply}>
              Save tags
            </button>
          </>
        }
      >
        {body}
      </Sheet>
    );
  }
  return (
    <div className="cts-pop-scrim" onClick={onClose}>
      <div className="cts-pop ibx-wrap" role="dialog" aria-modal="true" aria-label="Tags" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()} data-testid="contacts-tags">
        <div className="sb">
          <h3>Tags{many ? " for everyone selected" : ""}</h3>
          <button type="button" className="ibx-ib" aria-label="Close" onClick={onClose}>
            <I name="i-x" />
          </button>
        </div>
        {body}
        <div className="cts-popf">
          <button type="button" className="ibx-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn pri" onClick={apply}>
            Save tags
          </button>
        </div>
      </div>
    </div>
  );
}
