import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  centsText,
  DM_AI_DELAYS,
  DM_AI_RESUME,
  DM_AI_TOPIC_INFO,
  DM_AI_TOPICS,
  DM_STAGE_LABEL,
  DM_STAGES,
  type DmAiAccountView,
  type DmAiOverview,
  type DmAiQueueRow,
  type DmAiSettings,
  type DmAiSettingsPatch,
  type DmStage,
} from "@toreroflow/core";
import Pf from "../Pf";
import { useToast } from "../Toasts";
import { api, type ClientSummary } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { usePageHead } from "../../lib/pageHead";
import { PF_ID } from "../../lib/platforms";
import { tone, who } from "../../lib/inbox";
import { aiBand, delayChip, delayPreset, delaySummary, handoffSummary, knowsSummary, neverSummary, queueNote, resumeLabel, waitText } from "../../lib/aiMetrics";
import { useAppState } from "../../state/AppState";
import { CouldNotLoad, Dialog, I, KwBox, Skeleton, Switch } from "../automations/parts";
import { Avatar, Channel } from "../inbox/parts";
import "./areas.css";

/**
 * Workflows > AI replies (F5): round 2 mockup 03, desktop and phone. One
 * status band with a switch per account, the Needs you queue (chats waiting
 * on a person and chats the AI handed off), the period's numbers and stage
 * mix, and How it answers folded into rows that open an editor. OFF until a
 * person turns it on; drafts only until someone picks "Send it on its own".
 * Viewers read only.
 */

const RETRY_MS = 15_000;
const POLL_MS = 30_000;
type Range = "today" | "7" | "30";
const RANGES: Array<{ id: Range; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
];
const STAGE_COLOR: Record<DmStage, string> = {
  new: "rgba(255,255,255,.4)",
  engaged: "var(--ibx-info)",
  qualify: "var(--ibx-trial)",
  offer: "var(--ibx-drive)",
  link: "var(--ibx-warn)",
  won: "var(--ibx-ok)",
};
type Editor = "timing" | "knows" | "never" | "handoff" | "test" | null;

export default function AiReplies({ client, onOpenThread }: { client: ClientSummary; onOpenThread(threadId: string): void }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const [range, setRange] = useState<Range>("7");
  const [data, setData] = useState<DmAiOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [filter, setFilter] = useState<"all" | "waiting" | "handoff">("all");
  const [editing, setEditing] = useState<Editor>(null);
  const [acctId, setAcctId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<DmAiQueueRow | null>(null);
  const [acctSheet, setAcctSheet] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<DmAiOverview>(`/clients/${client.id}/dm/ai?range=${range}`);
      setData(r);
      setErr(null);
      setLastLoaded(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load AI replies");
    }
  }, [client.id, range]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), data ? POLL_MS : RETRY_MS);
    return () => window.clearInterval(t);
  }, [load, data]);

  const accounts = data?.accounts ?? [];
  // The account How it answers shows: the one picked, else the first that is on, else the first Instagram.
  const acct = accounts.find((a) => a.accountId === acctId) ?? accounts.find((a) => a.settings.enabled) ?? accounts.find((a) => a.platform === "instagram") ?? accounts[0] ?? null;
  const band = useMemo(() => aiBand(accounts, data?.killedAt ?? null, client.name), [accounts, data?.killedAt, client.name]);

  const save = async (a: DmAiAccountView, patch: DmAiSettingsPatch, done?: string): Promise<boolean> => {
    try {
      const r = await api.put<{ account: DmAiAccountView }>(`/clients/${client.id}/dm/ai/${a.accountId}`, patch);
      setData((d) => d && { ...d, accounts: d.accounts.map((x) => (x.accountId === a.accountId ? r.account : x)) });
      if (done) toast.success(done);
      return true;
    } catch (e) {
      toast.fail("Could not save", e);
      return false;
    }
  };
  const toggle = (a: DmAiAccountView, on: boolean) =>
    void save(
      a,
      { enabled: on },
      on
        ? `AI replies are on for ${label(a)}: ${a.settings.mode === "autopilot" ? "it answers on its own" : "it writes drafts, a person sends them"}.`
        : `AI replies are off for ${label(a)}.`,
    );
  const kill = async (stopped: boolean) => {
    try {
      const r = await api.post<{ killedAt: string | null }>(`/clients/${client.id}/dm/ai/kill`, { stopped });
      setData((d) => d && { ...d, killedAt: r.killedAt });
      toast.success(stopped ? "AI sending is stopped for every account. Drafts still come." : "AI sending is back on where autopilot is chosen.");
    } catch (e) {
      toast.fail("Could not change it", e);
    }
  };
  const threadAction = async (r: DmAiQueueRow, what: "done" | "resume" | "friend") => {
    try {
      if (what === "done") await api.patch(`/clients/${client.id}/dm/threads/${r.threadId}`, { status: "done" });
      else if (what === "resume") await api.post(`/clients/${client.id}/dm/threads/${r.threadId}/ai`, { resume: true });
      else await api.patch(`/clients/${client.id}/dm/contacts/${r.contact.id}`, { tags: [...new Set([...r.contact.tags, "friend"])] });
      toast.success(what === "done" ? "Marked as done." : what === "resume" ? "The AI can answer in this chat again." : "Tagged friend. The AI never replies to friends.");
      await load();
    } catch (e) {
      toast.fail("Could not change it", e);
    }
  };

  usePageHead(
    !isPhone
      ? {
          controls: (
            <>
              <div className="wa-hseg" role="tablist" aria-label="Period">
                {RANGES.map((r) => (
                  <button key={r.id} type="button" role="tab" aria-selected={range === r.id} className={range === r.id ? "on" : undefined} onClick={() => setRange(r.id)}>
                    {r.label}
                  </button>
                ))}
              </div>
              {!viewer && (
                <button type="button" className="au-hbtn" onClick={() => setEditing("test")} disabled={!accounts.length} data-testid="ai.test">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-beaker" />
                  </svg>
                  Try a test message
                </button>
              )}
            </>
          ),
        }
      : null,
  );

  const wrap = isPhone ? "ibx-wrap ph au wa" : "ibx-wrap au wa";
  if (!data) {
    return (
      <div className={wrap} data-testid="ai-replies" data-state={err ? "error" : "loading"}>
        {err ? <CouldNotLoad phone={isPhone} lastLoaded={lastLoaded} onRetry={() => void load()} what="AI replies" /> : <Skeleton phone={isPhone} label="Loading AI replies" />}
      </div>
    );
  }
  if (!accounts.length) {
    return (
      <div className={wrap} data-testid="ai-replies" data-state="empty">
        <section className={isPhone ? "mb-card ibx-empty" : "au-card ibx-empty"}>
          <span className="ei">
            <I name="i-spark" />
          </span>
          <h3>Connect Instagram first</h3>
          <p>AI replies answer {client.name}'s Instagram DMs and write drafts for Messenger. Connect an account in Connected Accounts to start.</p>
        </section>
      </div>
    );
  }

  const queue = data.queue.filter((r) => filter === "all" || r.why === filter);
  const now = Date.now();
  const periodLabel = range === "today" ? "Today" : range === "30" ? "Last 30 days" : "This week";
  const periodSub = `${new Date(data.period.from).toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${new Date(data.period.to).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const stageTotal = DM_STAGES.reduce((s, k) => s + data.stages[k], 0);
  const anyAuto = accounts.some((a) => a.settings.enabled && a.settings.mode === "autopilot");
  const label = (a: DmAiAccountView) => (a.platform === "facebook" ? "Messenger" : `@${a.handle}`);
  const s = acct?.settings ?? null;

  const notices = (
    <>
      {!data.configured && (
        <div className={isPhone ? "au-slim warn" : "au-notice warn"}>
          <I name="i-alert" />
          <span className="grow">The server has no ANTHROPIC_API_KEY, so the AI cannot write replies yet.</span>
        </div>
      )}
      {viewer && (
        <div className={isPhone ? "au-slim info" : "au-notice info"}>
          <I name="i-eye" />
          <span className="grow">Read only. You are signed in as a viewer, so the switches and settings are for the team.</span>
        </div>
      )}
    </>
  );

  const statsRow = [
    { k: isPhone ? "Answered" : "chats answered without help", v: String(data.stats.answered) },
    { k: isPhone ? "Handed off" : "handed to your team", v: String(data.stats.handedOff) },
    { k: isPhone ? "Spent" : `spent on the AI, ${centsText(data.monthCostCents)} this month`, v: centsText(data.stats.costCents) },
  ];

  const answerRows: Array<{ id: Exclude<Editor, "test" | null>; icon: string; b: string; s: string }> = s
    ? [
        { id: "knows", icon: "i-bulb", b: "What the AI knows", s: knowsSummary(s, isPhone) },
        { id: "timing", icon: "i-clock", b: "Reply timing", s: s.mode === "autopilot" ? delaySummary(s, isPhone) : "Drafts only: a person sends each reply" },
        { id: "never", icon: "i-shield", b: "Never auto-reply to", s: neverSummary(data.never, isPhone) },
        { id: "handoff", icon: "i-hand", b: "When it hands off", s: handoffSummary(s) },
      ]
    : [];

  const editor = editing && acct && (
    <EditorDialog
      kind={editing}
      phone={isPhone}
      clientId={client.id}
      account={acct}
      accounts={accounts}
      overview={data}
      onPick={setAcctId}
      onClose={() => setEditing(null)}
      onSave={(patch, done) => save(acct, patch, done)}
      onChanged={() => void load()}
    />
  );

  const menu = menuFor && (
    <QueueMenu
      row={menuFor}
      phone={isPhone}
      viewer={viewer}
      onClose={() => setMenuFor(null)}
      onOpen={() => (setMenuFor(null), onOpenThread(menuFor.threadId))}
      onAction={(w) => (setMenuFor(null), void threadAction(menuFor, w))}
    />
  );

  // ---------------------------------------------------------------------------
  // Phone (mockup 03-ai-replies-phone)
  // ---------------------------------------------------------------------------
  if (isPhone) {
    const on = accounts.filter((a) => a.settings.enabled);
    const shown = more ? queue : queue.slice(0, 4);
    return (
      <div className={wrap} data-testid="ai-replies" data-state="ready" data-ai={band.state}>
        {notices}
        <section className="wa-status">
          <div className="top">
            <span className={`bi ${band.state === "on" ? "ok" : band.state === "drafts" ? "info" : band.state === "stopped" ? "bad" : ""}`}>
              <I name="i-spark" />
            </span>
            <span className="bt">
              <b>
                {band.title} <span className={`au-pill${band.pill.cls ? ` ${band.pill.cls}` : ""}`}>{band.pill.label}</span>
              </b>
              <small>{band.state === "off" ? "Off for every account until you turn it on." : "Says it is an assistant if asked. Never pretends to be a person."}</small>
            </span>
          </div>
          <button type="button" className="au-linkrow" onClick={() => setAcctSheet(true)} data-testid="ai.accounts">
            <span className="k">Answers on</span>
            <span className="v">
              {on[0] ? (
                <>
                  <Pf p={PF_ID[on[0].platform]} size="xs" />
                  {label(on[0])} <span className="muted" style={{ fontWeight: 500 }}>{on.length} of {accounts.length}</span>
                </>
              ) : (
                <span className="muted">No account yet</span>
              )}
            </span>
            <I name="i-chev-r" className="chev" />
          </button>
        </section>

        <div className="au-sech">
          <h2>Needs you</h2>
          <span className="small muted">{data.counts.all} {data.counts.all === 1 ? "chat" : "chats"}</span>
        </div>
        <section className="au-rlist" aria-label="Needs you">
          {!queue.length && <p className="ibx-nomatch">Nobody is waiting on you. Chats show up here after 30 minutes with no answer, or when the AI hands one over.</p>}
          {shown.map((r) => (
            <div key={`${r.why}:${r.threadId}`} className="au-ar wa-ar" data-testid="ai.queue.row">
              <Avatar contact={r.contact} size={36} />
              <button type="button" className="t" onClick={() => onOpenThread(r.threadId)}>
                <b>{who(r.contact)}</b>
                <small>
                  <span className={`wa-why${r.why === "waiting" ? " wait" : ""}`}>
                    <I name={r.why === "waiting" ? "i-clock" : "i-hand"} />
                    {r.why === "waiting" ? waitText(r.since, now, true) : "Handed off"}
                  </span>
                  <span className="grow">{r.why === "waiting" ? (r.platform === "facebook" ? "Messenger, AI is off there" : r.preview ? `"${r.preview}"` : "") : r.reason}</span>
                </small>
              </button>
              <button type="button" className="mb-ib ghost" aria-label={`More for ${who(r.contact)}`} onClick={() => setMenuFor(r)}>
                <I name="i-dots-h" />
              </button>
            </div>
          ))}
          {queue.length > 4 && (
            <button type="button" className="au-showmore" onClick={() => setMore((v) => !v)}>
              {more ? "Show fewer" : `Show ${queue.length - 4} more`}
              <I name="i-chev" />
            </button>
          )}
        </section>

        <div className="au-sech">
          <h2>{periodLabel}</h2>
          <span className="small muted">{periodSub}</span>
        </div>
        <div className="au-mstats">
          {statsRow.map((x) => (
            <div key={x.k}>
              <div className="k">{x.k}</div>
              <div className="v">{x.v}</div>
            </div>
          ))}
        </div>

        <div className="au-sech">
          <h2>How it answers</h2>
          {accounts.length > 1 && acct && <span className="small muted">{label(acct)}</span>}
        </div>
        <section className="mb-card list">
          {answerRows.map((r) => (
            <button key={r.id} type="button" className="mb-lrow au-basicrow" onClick={() => setEditing(r.id)} disabled={viewer && r.id !== "knows"} data-testid={`ai.edit.${r.id}`}>
              <span className="au-lic">
                <I name={r.icon} />
              </span>
              <span className="mb-lt">
                <b>{r.b}</b>
                <small>{r.s}</small>
              </span>
              <I name="i-chev-r" />
            </button>
          ))}
        </section>
        {!viewer && (
          <button type="button" className="mb-btn block" onClick={() => setEditing("test")} data-testid="ai.test">
            <I name="i-beaker" />
            Try a test message
          </button>
        )}
        {!viewer && anyAuto && (
          <button type="button" className="fl-stop" onClick={() => void kill(!data.killedAt)} data-testid="ai.kill">
            <I name={data.killedAt ? "i-refresh" : "i-pause"} />
            {data.killedAt ? "Start AI sending again" : "Stop all AI sending"}
          </button>
        )}

        {acctSheet && (
          <AccountsDialog phone accounts={accounts} viewer={viewer} killedAt={data.killedAt} onToggle={toggle} onKill={kill} onPick={(id) => (setAcctId(id), setAcctSheet(false))} onClose={() => setAcctSheet(false)} />
        )}
        {menu}
        {editor}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Desktop and web (mockup 03-ai-replies-desktop)
  // ---------------------------------------------------------------------------
  return (
    <div className={wrap} data-testid="ai-replies" data-state="ready" data-ai={band.state}>
      {notices}
      <section className="wa-band">
        <span className={`bi ${band.state === "on" ? "ok" : band.state === "drafts" ? "info" : band.state === "stopped" ? "bad" : ""}`}>
          <I name="i-spark" />
        </span>
        <div className="bt">
          <b>
            {band.title} <span className={`au-pill${band.pill.cls ? ` ${band.pill.cls}` : ""}`}>{band.pill.label}</span>
          </b>
          <small>{band.line}</small>
          {!viewer && anyAuto && (
            <span className="wa-kill">
              <button type="button" className="au-lnk" onClick={() => void kill(!data.killedAt)} data-testid="ai.kill">
                {data.killedAt ? "Start AI sending again" : "Stop all AI sending"}
              </button>
              {data.killedAt ? `Stopped ${new Date(data.killedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Stops every account at once"}
            </span>
          )}
        </div>
        <div className="wa-accts">
          {accounts.map((a) => (
            <span key={a.accountId} className={`wa-atog${a.settings.enabled ? "" : " off"}`} title={a.settings.enabled ? (a.settings.mode === "autopilot" ? "Sends on its own" : "Drafts only") : "Off"}>
              <Pf p={PF_ID[a.platform]} size="sm" />
              {label(a)}
              <Switch on={a.settings.enabled} label={`AI replies for ${label(a)}`} disabled={viewer} onChange={(v) => toggle(a, v)} />
            </span>
          ))}
        </div>
      </section>

      <div className="wa-aigrid">
        <section className="au-card p0" aria-label="Needs you">
          <div className="wa-qhead">
            <div className="sect-t">
              <h3>Needs you</h3>
              <small>The AI stepped back from these chats</small>
            </div>
            <div className="ibx-seg" role="tablist" aria-label="Show">
              {(
                [
                  ["all", "All", data.counts.all],
                  ["waiting", "Waiting", data.counts.waiting],
                  ["handoff", "Handed off", data.counts.handoff],
                ] as const
              ).map(([id, l, c]) => (
                <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "on" : undefined} onClick={() => setFilter(id)}>
                  {l} {c}
                </button>
              ))}
            </div>
          </div>
          {!queue.length && <p className="wa-qempty">Nobody is waiting on you. Chats show up here after 30 minutes with no answer, or when the AI hands one over.</p>}
          {queue.map((r) => (
            <div key={`${r.why}:${r.threadId}`} className="wa-qrow" data-testid="ai.queue.row">
              <Avatar contact={r.contact} size={32} />
              <span className="who">
                <b>
                  <span>{who(r.contact)}</span>
                  <Channel platform={r.platform} label={r.platform === "facebook" ? "Messenger" : "IG"} />
                  {r.paused && <span className="ibx-sc paused">Paused</span>}
                </b>
                <small>{queueNote(r, accounts)}</small>
              </span>
              <span className={`wa-why${r.why === "waiting" ? " wait" : ""}`}>
                <I name={r.why === "waiting" ? "i-clock" : "i-hand"} />
                {r.why === "waiting" ? waitText(r.since, now) : r.reason}
              </span>
              <span className="row">
                <button type="button" className="ibx-btn" onClick={() => onOpenThread(r.threadId)}>
                  Open
                </button>
              </span>
            </div>
          ))}
          <p className="wa-qfoot">Waiting: nobody has answered for 30 minutes or more. Handed off: the AI passed it to you and stays out of that chat until you let it answer again.</p>
        </section>

        <aside className="wa-side">
          <section className="au-card">
            <div className="sect-t">
              <h3>{periodLabel}</h3>
              <small>{periodSub}</small>
            </div>
            <div className="wa-wk">
              {statsRow.map((x) => (
                <div key={x.k}>
                  <div className="v">{x.v}</div>
                  <div className="k">{x.k}</div>
                </div>
              ))}
            </div>
            <div className="wa-sbar" aria-label="Where people are now">
              {stageTotal > 0 && DM_STAGES.map((k) => data.stages[k] > 0 && <i key={k} style={{ flex: data.stages[k], ["--c" as string]: STAGE_COLOR[k] }} />)}
            </div>
            <div className="wa-slegend">
              {DM_STAGES.map((k) => (
                <span key={k}>
                  <i style={{ ["--c" as string]: STAGE_COLOR[k] }} />
                  {DM_STAGE_LABEL[k]} {data.stages[k]}
                </span>
              ))}
            </div>
          </section>
          <section className="au-card p0">
            <div className="sect-t au-rowsb" style={{ paddingRight: 18 }}>
              <h3>How it answers</h3>
              {accounts.length > 1 && acct && (
                <label className="au-hsel" style={{ height: 30 }}>
                  <Pf p={PF_ID[acct.platform]} size="xs" />
                  <select aria-label="Account" value={acct.accountId} onChange={(e) => setAcctId(e.target.value)}>
                    {accounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {label(a)}
                      </option>
                    ))}
                  </select>
                  <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-chev" />
                  </svg>
                </label>
              )}
            </div>
            {answerRows.map((r) => (
              <div key={r.id} className="wa-disc">
                <span className="ic">
                  <I name={r.icon} />
                </span>
                <span className="lt">
                  <b>{r.b}</b>
                  <small title={r.s}>{r.s}</small>
                </span>
                <button type="button" className="ibx-btn ghost" onClick={() => setEditing(r.id)} data-testid={`ai.edit.${r.id}`}>
                  {viewer ? "View" : "Edit"}
                </button>
              </div>
            ))}
          </section>
        </aside>
      </div>
      {menu}
      {editor}
    </div>
  );
}

// -----------------------------------------------------------------------------
// The account switches (phone "Answers on" sheet)
// -----------------------------------------------------------------------------

function AccountsDialog({
  phone,
  accounts,
  viewer,
  killedAt,
  onToggle,
  onKill,
  onPick,
  onClose,
}: {
  phone: boolean;
  accounts: DmAiAccountView[];
  viewer: boolean;
  killedAt: string | null;
  onToggle(a: DmAiAccountView, on: boolean): void;
  onKill(stopped: boolean): void;
  onPick(id: string): void;
  onClose(): void;
}) {
  return (
    <Dialog phone={phone} title="Answers on" sub="AI replies for each account. Off until you turn one on." onClose={onClose} foot={<button type="button" className="mb-btn block" onClick={onClose}>Done</button>} testId="ai.accounts-sheet">
      <div className="mb-card list au-optlist">
        {accounts.map((a) => (
          <div key={a.accountId} className="au-optrow">
            <Pf p={PF_ID[a.platform]} size="sm" />
            <button type="button" className="lt" onClick={() => onPick(a.accountId)}>
              <b>{a.platform === "facebook" ? "Messenger" : `@${a.handle}`}</b>
              <small>{!a.settings.enabled ? "Off" : a.settings.mode === "autopilot" ? "Sends on its own" : "Drafts only"}{a.canAutopilot ? "" : a.platform === "facebook" ? ", reply only" : ", drafts until connected"}</small>
            </button>
            <Switch on={a.settings.enabled} label={`AI replies for ${a.handle}`} disabled={viewer} onChange={(v) => onToggle(a, v)} />
          </div>
        ))}
      </div>
      {!viewer && accounts.some((a) => a.settings.enabled && a.settings.mode === "autopilot") && (
        <div className="au-am">
          <button type="button" className={killedAt ? undefined : "bad"} onClick={() => onKill(!killedAt)}>
            <I name={killedAt ? "i-refresh" : "i-pause"} />
            <span className="grow">
              {killedAt ? "Start AI sending again" : "Stop all AI sending"}
              <small>{killedAt ? "Autopilot accounts answer on their own again" : "Every account at once. Drafts still come"}</small>
            </span>
          </button>
        </div>
      )}
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// A Needs you row's actions (phone actions sheet; desktop uses Open)
// -----------------------------------------------------------------------------

function QueueMenu({ row, phone, viewer, onClose, onOpen, onAction }: { row: DmAiQueueRow; phone: boolean; viewer: boolean; onClose(): void; onOpen(): void; onAction(w: "done" | "resume" | "friend"): void }) {
  const name = who(row.contact);
  return (
    <Dialog
      phone={phone}
      title={name}
      sub={row.why === "waiting" ? `${waitText(row.since)} on ${row.platform === "facebook" ? "Messenger" : "Instagram"}` : `Handed off: ${row.reason}`}
      onClose={onClose}
      foot={<button type="button" className="mb-btn block" onClick={onClose}>Cancel</button>}
      testId="ai.queue.menu"
    >
      <div className="au-am">
        <button type="button" onClick={onOpen}>
          <I name="i-comment" />
          <span className="grow">Open the chat</span>
        </button>
        {!viewer && (
          <>
            <button type="button" onClick={() => onAction("done")}>
              <I name="i-check-circle" />
              <span className="grow">Mark as done</span>
            </button>
            {(row.why === "handoff" || row.aiOff) && (
              <button type="button" onClick={() => onAction("resume")}>
                <I name="i-spark" />
                <span className="grow">
                  Let the AI answer again<small>In this chat only</small>
                </span>
              </button>
            )}
            {!row.contact.tags.some((t) => t.toLowerCase() === "friend") && (
              <button type="button" onClick={() => onAction("friend")}>
                <I name="i-shield" />
                <span className="grow">
                  Tag as friend<small>The AI never replies to friends</small>
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// The editors: timing, knowledge, never-reply, handoff rules, Try a test message
// -----------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourText = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });

function EditorDialog({
  kind,
  phone,
  clientId,
  account,
  accounts,
  overview,
  onPick,
  onClose,
  onSave,
  onChanged,
}: {
  kind: Exclude<Editor, null>;
  phone: boolean;
  clientId: string;
  account: DmAiAccountView;
  accounts: DmAiAccountView[];
  overview: DmAiOverview;
  onPick(id: string): void;
  onClose(): void;
  onSave(patch: DmAiSettingsPatch, done?: string): Promise<boolean>;
  onChanged(): void;
}) {
  const toast = useToast();
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const [f, setF] = useState<DmAiSettings>(account.settings);
  useEffect(() => setF(account.settings), [account]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DmAiSettings>(k: K, v: DmAiSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  const name = account.platform === "facebook" ? "Messenger" : `@${account.handle}`;
  const field = (labelText: string, body: ReactNode, help?: string) => (
    <div className={phone ? "mb-field" : "au-field"}>
      <span className={phone ? "mb-flab" : "flab"}>{labelText}</span>
      {body}
      {help && <span className="au-help">{help}</span>}
    </div>
  );
  const pickAccount =
    accounts.length > 1 && kind !== "never" ? (
      field(
        "Account",
        <label className="au-select">
          <Pf p={PF_ID[account.platform]} size="xs" />
          <select value={account.accountId} onChange={(e) => onPick(e.target.value)} aria-label="Account">
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.platform === "facebook" ? "Messenger" : `@${a.handle}`}
              </option>
            ))}
          </select>
          <I name="i-chev" className="chev" />
        </label>,
      )
    ) : null;
  const commit = async (patch: DmAiSettingsPatch, done: string) => {
    setBusy(true);
    const ok = await onSave(patch, done);
    setBusy(false);
    if (ok) onClose();
  };
  const foot = (patch: DmAiSettingsPatch, done: string) =>
    viewer ? (
      <button type="button" className={phone ? "mb-btn block" : "au-hbtn"} onClick={onClose}>
        Close
      </button>
    ) : (
      <>
        <button type="button" className={phone ? "mb-btn ghost" : "au-hbtn"} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={phone ? "mb-btn pri" : "au-hbtn pri"} disabled={busy} onClick={() => void commit(patch, done)} data-testid="ai.save">
          {busy ? "Saving..." : "Save"}
        </button>
      </>
    );

  if (kind === "timing") {
    const preset = delayPreset(f);
    return (
      <Dialog phone={phone} title="Reply timing" sub={name} onClose={onClose} foot={foot(
        { mode: f.mode, replyDelayMinSec: f.replyDelayMinSec, replyDelayMaxSec: f.replyDelayMaxSec, typing: f.typing, pauseOnTeamReply: f.pauseOnTeamReply, resumeAfterHours: f.resumeAfterHours, quietStartHour: f.quietStartHour, quietEndHour: f.quietEndHour, dailyCap: f.dailyCap },
        "Reply timing saved.",
      )} testId="ai.timing">
        <div className="au-sheetform">
          {pickAccount}
          {field(
            "When a reply is ready",
            <div className={`ibx-seg full${phone ? " ph" : ""}`} role="radiogroup" aria-label="When a reply is ready">
              <button type="button" role="radio" aria-checked={f.mode === "drafts"} className={f.mode === "drafts" ? "on" : undefined} onClick={() => set("mode", "drafts")} disabled={viewer}>
                Leave a draft
              </button>
              <button type="button" role="radio" aria-checked={f.mode === "autopilot"} className={f.mode === "autopilot" ? "on" : undefined} onClick={() => set("mode", "autopilot")} disabled={viewer || !account.canAutopilot} data-testid="ai.autopilot">
                Send it on its own
              </button>
            </div>,
            account.canAutopilot
              ? "Drafts wait in the Inbox for a person to send. On its own, it answers inside the 24 hour window, never in paused or handed-off chats."
              : account.platform === "facebook"
                ? "Messenger is reply only, so the AI only writes drafts there."
                : "Sending on its own needs this account connected through Torerone's Meta app. Until then it writes drafts.",
          )}
          {field(
            "Wait before replying",
            <div className={`ibx-seg full${phone ? " ph" : ""}`} role="radiogroup" aria-label="Wait before replying">
              {DM_AI_DELAYS.map((d) => (
                <button key={d.id} type="button" role="radio" aria-checked={preset === d.id} className={preset === d.id ? "on" : undefined} disabled={viewer} onClick={() => setF((x) => ({ ...x, replyDelayMinSec: d.min, replyDelayMaxSec: d.max }))}>
                  {d.label}
                </button>
              ))}
            </div>,
            preset ? "A random wait, so replies do not land instantly." : `Now ${delayChip(f)}. A random wait, so replies do not land instantly.`,
          )}
          <div className={phone ? "mb-card list au-optlist" : "au-optlist"}>
            <div className="au-optrow">
              <span className="lt">
                <b>Show typing while it writes</b>
                <small>The typing dots in their chat</small>
              </span>
              <Switch on={f.typing} label="Show typing while it writes" disabled={viewer} onChange={(v) => set("typing", v)} />
            </div>
            <div className="au-optrow">
              <span className="lt">
                <b>Pause when your team replies</b>
                <small>So you do not talk over each other</small>
              </span>
              <Switch on={f.pauseOnTeamReply} label="Pause when your team replies" disabled={viewer} onChange={(v) => set("pauseOnTeamReply", v)} />
            </div>
          </div>
          {field(
            "Turn back on after a pause",
            <label className="au-select">
              <select value={f.resumeAfterHours} onChange={(e) => set("resumeAfterHours", Number(e.target.value))} disabled={viewer || !f.pauseOnTeamReply} aria-label="Turn back on after a pause">
                {[...new Set([...DM_AI_RESUME, f.resumeAfterHours])].map((h) => (
                  <option key={h} value={h}>
                    {resumeLabel(h)}
                  </option>
                ))}
              </select>
              <I name="i-chev" className="chev" />
            </label>,
          )}
          {field(
            "Quiet hours",
            <div className="wa-hours">
              <label className="au-select">
                <select value={f.quietStartHour ?? ""} onChange={(e) => set("quietStartHour", e.target.value === "" ? null : Number(e.target.value))} disabled={viewer} aria-label="Quiet from">
                  <option value="">None</option>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourText(h)}
                    </option>
                  ))}
                </select>
                <I name="i-chev" className="chev" />
              </label>
              to
              <label className="au-select">
                <select value={f.quietEndHour ?? ""} onChange={(e) => set("quietEndHour", e.target.value === "" ? null : Number(e.target.value))} disabled={viewer || f.quietStartHour === null} aria-label="Quiet until">
                  <option value="">None</option>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourText(h)}
                    </option>
                  ))}
                </select>
                <I name="i-chev" className="chev" />
              </label>
            </div>,
            `Nothing goes out on its own in these hours (${overview.timezone}). Replies wait as drafts.`,
          )}
          {field(
            "Most replies a day",
            <input className={phone ? "mb-input" : "au-input"} type="number" inputMode="numeric" min={1} max={500} value={f.dailyCap} disabled={viewer} onChange={(e) => e.target.valueAsNumber > 0 && set("dailyCap", Math.min(500, Math.round(e.target.valueAsNumber)))} aria-label="Most replies a day" />,
            `Past this many on ${name} in a day, replies stay drafts. ${account.sentToday} sent in the last 24 hours.`,
          )}
        </div>
      </Dialog>
    );
  }

  if (kind === "knows") {
    const links = f.links.length ? f.links : [];
    return (
      <Dialog phone={phone} title="What the AI knows" sub={`${name}. Used in every reply.`} onClose={onClose} foot={foot({ instructions: f.instructions, links: f.links.filter((l) => l.label.trim() && l.url.trim()), lessons: f.lessons }, "Saved. The next reply uses it.")} testId="ai.knows">
        <div className="au-sheetform">
          {pickAccount}
          {field(
            "About the business and how to answer",
            <textarea className={phone ? "mb-input au-text" : "au-text"} rows={phone ? 6 : 7} maxLength={4000} value={f.instructions} disabled={viewer} onChange={(e) => set("instructions", e.target.value)} placeholder="Hours, prices it may quote, the tone (friendly and short), and what to hand to the team." aria-label="About the business and how to answer" />,
            `${f.instructions.length} / 4000`,
          )}
          {field(
            "Links it can send",
            <div className="au-optlist">
              {links.map((l, i) => (
                <div key={i} className="wa-lnkrow">
                  <input className={phone ? "mb-input" : "au-input"} value={l.label} maxLength={40} placeholder="Booking page" disabled={viewer} aria-label="Link name" onChange={(e) => set("links", f.links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
                  <input className={phone ? "mb-input mono" : "au-input mono"} value={l.url} maxLength={500} placeholder="https://" inputMode="url" disabled={viewer} aria-label="Link address" onChange={(e) => set("links", f.links.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)))} />
                  {!viewer && (
                    <button type="button" className="ibx-btn icon ghost" aria-label="Remove link" onClick={() => set("links", f.links.filter((_, k) => k !== i))}>
                      <I name="i-x" />
                    </button>
                  )}
                </div>
              ))}
              {!viewer && f.links.length < 5 && (
                <button type="button" className="au-lnk" onClick={() => set("links", [...f.links, { label: "", url: "https://" }])}>
                  <I name="i-plus" />
                  Add a link
                </button>
              )}
            </div>,
            "It sends only these links, exactly as written.",
          )}
          {field(
            "What it learned from handoffs",
            <div className="au-optlist">
              {!f.lessons.length && <p className="au-help">Nothing yet. Add what your team answered when the AI handed a chat over.</p>}
              {f.lessons.map((l, i) => (
                <div key={l.id} className="wa-lesson">
                  <input className={phone ? "mb-input grow" : "au-input grow"} value={l.text} maxLength={300} disabled={viewer} aria-label="Lesson" onChange={(e) => set("lessons", f.lessons.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
                  {!viewer && (
                    <button type="button" className="ibx-btn icon ghost" aria-label="Remove" onClick={() => set("lessons", f.lessons.filter((_, k) => k !== i))}>
                      <I name="i-trash" />
                    </button>
                  )}
                </div>
              ))}
              {!viewer && f.lessons.length < 30 && (
                <button type="button" className="au-lnk" onClick={() => set("lessons", [...f.lessons, { id: `l${Date.now().toString(36)}`, text: "", from: "team", at: new Date().toISOString() }])}>
                  <I name="i-plus" />
                  Add a lesson
                </button>
              )}
            </div>,
          )}
        </div>
      </Dialog>
    );
  }

  if (kind === "handoff") {
    return (
      <Dialog phone={phone} title="When it hands off" sub={`${name}. A match hands the chat to your team before the AI writes anything.`} onClose={onClose} foot={foot({ handoffTopics: f.handoffTopics, handoffWords: f.handoffWords }, "Handoff rules saved.")} testId="ai.handoff">
        <div className="au-sheetform">
          {pickAccount}
          <div className={phone ? "mb-card list au-optlist" : "au-optlist"}>
            {DM_AI_TOPICS.map((t) => (
              <div key={t} className="au-optrow">
                <span className="lt">
                  <b>{DM_AI_TOPIC_INFO[t].label}</b>
                  <small>Shows as "{DM_AI_TOPIC_INFO[t].why}"</small>
                </span>
                <Switch on={f.handoffTopics.includes(t)} label={DM_AI_TOPIC_INFO[t].label} disabled={viewer} onChange={(v) => set("handoffTopics", v ? [...f.handoffTopics, t] : f.handoffTopics.filter((x) => x !== t))} />
              </div>
            ))}
          </div>
          {field("Your own words", <KwBox value={f.handoffWords} onChange={(v) => set("handoffWords", v)} placeholder="For example: wholesale, collab" label="Handoff words" disabled={viewer} phone={phone} />, "Any of these in their message hands it to your team.")}
          <p className="au-help">It also hands off anything it is not sure of, health, legal and safety questions, and anyone upset.</p>
        </div>
      </Dialog>
    );
  }

  if (kind === "never") return <NeverDialog phone={phone} clientId={clientId} overview={overview} viewer={viewer} onClose={onClose} onChanged={onChanged} />;

  return <TestDialog phone={phone} clientId={clientId} account={account} accounts={accounts} onPick={onPick} onClose={onClose} toast={toast} />;
}

function NeverDialog({ phone, clientId, overview, viewer, onClose, onChanged }: { phone: boolean; clientId: string; overview: DmAiOverview; viewer: boolean; onClose(): void; onChanged(): void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Array<{ id: string; displayName: string | null; handle: string | null; tags: string[]; platform: "instagram" | "facebook" }>>([]);
  useEffect(() => {
    if (!q.trim()) return setFound([]);
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<{ contacts: typeof found }>(`/clients/${clientId}/dm/contacts?search=${encodeURIComponent(q.trim())}`)
        .then((r) => live && setFound(r.contacts.slice(0, 6)))
        .catch(() => live && setFound([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, clientId]);
  const run = async (p: Promise<unknown>, done: string) => {
    try {
      await p;
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.fail("Could not change it", e);
    }
  };
  return (
    <Dialog phone={phone} title="Never auto-reply to" sub="Friends, family and partners. The AI stays quiet in these chats. Anyone tagged friend is skipped too." onClose={onClose} foot={<button type="button" className={phone ? "mb-btn block" : "au-hbtn"} onClick={onClose}>Done</button>} testId="ai.never">
      <div className="au-sheetform">
        <div className="au-optlist">
          {!overview.never.list.length && <p className="au-help">Nobody yet.</p>}
          {overview.never.list.map((p) => (
            <div key={`${p.via}:${p.contactId}`} className="wa-ff">
              <span className={`ibx-av s32 ${tone(p.contactId)}`}>{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="grow">
                <b>{p.name}</b>
                <small>{[p.platform === "facebook" ? "Messenger" : p.handle ? `@${p.handle}` : "Instagram", p.note].filter(Boolean).join(", ")}</small>
              </span>
              <span className="wa-tag">{p.via === "friend" ? "friend" : "AI off"}</span>
              {!viewer && (
                <button
                  type="button"
                  className="ibx-btn icon ghost"
                  aria-label={`Let the AI answer ${p.name} again`}
                  onClick={() =>
                    void run(
                      p.via === "off" && p.threadId
                        ? api.post(`/clients/${clientId}/dm/threads/${p.threadId}/ai`, { off: false })
                        : api.patch(`/clients/${clientId}/dm/contacts/${p.contactId}`, { tags: p.tags.filter((t) => t.toLowerCase() !== "friend") }),
                      `The AI can answer ${p.name} again.`,
                    )
                  }
                >
                  <I name="i-x" />
                </button>
              )}
            </div>
          ))}
        </div>
        {!viewer && (
          <div className={phone ? "mb-field" : "au-field"}>
            <span className={phone ? "mb-flab" : "flab"}>Add person</span>
            <label className="ibx-input round">
              <I name="i-search" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" aria-label="Search contacts" />
            </label>
            {found.map((c) => (
              <button
                key={c.id}
                type="button"
                className="au-opt"
                onClick={() => void run(api.patch(`/clients/${clientId}/dm/contacts/${c.id}`, { tags: [...new Set([...c.tags, "friend"])] }).then(() => setQ("")), `${who(c)} is tagged friend. The AI never replies to them.`)}
              >
                <Pf p={PF_ID[c.platform]} size="xs" />
                <span className="lt">
                  <b>{who(c)}</b>
                  <small>{c.handle ? `@${c.handle}` : "Messenger"}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function TestDialog({ phone, clientId, account, accounts, onPick, onClose, toast }: { phone: boolean; clientId: string; account: DmAiAccountView; accounts: DmAiAccountView[]; onPick(id: string): void; onClose(): void; toast: ReturnType<typeof useToast> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ action: string; bubbles: string[]; reason: string; rule?: boolean } | null>(null);
  const ask = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setOut(null);
    try {
      setOut(await api.post(`/clients/${clientId}/dm/ai/test`, { accountId: account.accountId, text: text.trim() }));
    } catch (e) {
      toast.fail("The AI could not answer", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      phone={phone}
      title="Try a test message"
      sub="What the AI would answer, from this account's settings. Nothing is sent."
      onClose={onClose}
      foot={
        <>
          <button type="button" className={phone ? "mb-btn ghost" : "au-hbtn"} onClick={onClose}>
            Close
          </button>
          <button type="button" className={phone ? "mb-btn pri" : "au-hbtn pri"} disabled={busy || !text.trim()} onClick={() => void ask()} data-testid="ai.test.ask">
            {busy ? "Writing..." : "Ask the AI"}
          </button>
        </>
      }
      testId="ai.test-dialog"
    >
      <div className="au-sheetform wa-test">
        {accounts.length > 1 && (
          <label className="au-select">
            <Pf p={PF_ID[account.platform]} size="xs" />
            <select value={account.accountId} onChange={(e) => onPick(e.target.value)} aria-label="Account">
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.platform === "facebook" ? "Messenger" : `@${a.handle}`}
                </option>
              ))}
            </select>
            <I name="i-chev" className="chev" />
          </label>
        )}
        <textarea className={phone ? "mb-input au-text" : "au-text"} rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Hi! Are you open on Sundays?" aria-label="Their message" />
        {out &&
          (out.action === "reply" ? (
            out.bubbles.map((b, i) => (
              <div key={i} className="au-dmcard">
                <p>{b}</p>
              </div>
            ))
          ) : (
            <p className="au-help warn">
              {out.action === "stop" ? "No reply needed" : out.rule ? `A handoff rule matched: ${out.reason}` : `It would hand this to your team: ${out.reason}`}
            </p>
          ))}
      </div>
    </Dialog>
  );
}
