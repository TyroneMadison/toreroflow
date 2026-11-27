import { useCallback, useEffect, useRef, useState } from "react";
import { DM_METRIC_KEYS, DM_METRIC_LABEL, type DmMetricsView } from "@toreroflow/core";
import { api } from "../lib/api";
import { useAppState } from "../state/AppState";
import Automations from "../components/automations/Automations";
import Inbox from "../components/inbox/Inbox";
import Contacts from "../components/inbox/Contacts";
import AiReplies from "../components/ai/AiReplies";
import Metrics from "../components/ai/Metrics";
import AutoPost from "../components/ai/AutoPost";
import { I } from "../components/automations/parts";
import { Empty } from "../components/states";
import { useIsPhone } from "../lib/phone";
import { kpiText } from "../lib/aiMetrics";
import { usePageHead } from "../lib/pageHead";
import { linkProps, navigate, useRoute, WORKFLOW_AREAS, type WorkflowArea } from "../lib/routes";
import type { ClientSummary } from "../lib/api";
import "../components/ai/areas.css";

/** Desktop and web: Workflows' seven areas in a slim rail with live counts (round 2 mockups). */
const AREA_ICON: Record<WorkflowArea | "overview", string> = {
  overview: "#i-dash",
  inbox: "#i-inbox",
  automations: "#i-bolt",
  "ai-replies": "#i-spark",
  contacts: "#i-users",
  metrics: "#i-chart",
  "auto-post": "#i-drive",
};

/** GET /clients/:id/dm/summary: what the rail and the phone chips show. */
interface Summary {
  unread: number;
  liveAutomations: number;
  contacts: number;
  ai: { on: number; autopilot: number };
  autoPost: { tone: "ok" | "bad" | "off"; label: string };
  fanoutRules: number;
}

/** The rail's tail for one area: "5 live", "On", "312", "Running" (mockup rail). */
function tailOf(id: WorkflowArea, s: Summary | null): { text: string; cls?: string } | null {
  if (!s) return null;
  if (id === "automations") return s.liveAutomations ? { text: `${s.liveAutomations} live` } : null;
  if (id === "ai-replies") return s.ai.on ? { text: s.ai.autopilot ? "On" : "Drafts", cls: s.ai.autopilot ? "okc" : undefined } : { text: "Off" };
  if (id === "contacts") return s.contacts ? { text: s.contacts.toLocaleString("en-US") } : null;
  if (id === "auto-post") return s.autoPost.tone === "off" ? null : { text: s.autoPost.tone === "bad" ? "Needs a look" : s.autoPost.label, cls: s.autoPost.tone === "bad" ? "badc" : "okc" };
  return null;
}

function WorkflowRail({ area, client, inboxNew, summary, mini = false }: { area: WorkflowArea | null; client: ClientSummary | null; inboxNew: number | null; summary: Summary | null; mini?: boolean }) {
  const dm = (client?.accounts ?? []).filter((a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"));
  const names = dm.map((a) => (a.platform === "instagram" ? `@${a.handle.replace(/^@/, "")}` : "Messenger"));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const rows: Array<{ id: WorkflowArea | null; label: string }> = [{ id: null, label: "Overview" }, ...WORKFLOW_AREAS];
  return (
    <nav className={`wfr-rail${mini ? " slim" : ""}`} aria-label="Workflows">
      <div className="lbl">Workflows</div>
      {rows.map((r) => {
        const on = r.id === area;
        const tail = r.id ? tailOf(r.id, summary) : null;
        return (
          <a
            key={r.id ?? "overview"}
            className={`wfr-ri${on ? " on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-label={mini ? r.label : undefined}
            title={mini ? r.label : undefined}
            {...linkProps("workflows", r.id)}
            data-testid={`workflows.area.${r.id ?? "overview"}`}
          >
            <svg aria-hidden="true">
              <use href={AREA_ICON[r.id ?? "overview"]} />
            </svg>
            <span>{r.label}</span>
            {r.id === "inbox" && !!inboxNew && (
              <span className="cnt">
                {inboxNew}
                <span className="vh"> new</span>
              </span>
            )}
            {tail && <span className={`tail${tail.cls ? ` ${tail.cls}` : ""}`}>{tail.text}</span>}
          </a>
        );
      })}
      <div className="wfr-foot">
        {dm.length ? `${dm.length} ${dm.length === 1 ? "account" : "accounts"} connected: ${list}` : "No Instagram or Facebook account connected yet"}
      </div>
    </nav>
  );
}

/**
 * Overview: the week's six numbers (Metrics) and one card per area with its
 * state and a way in, instead of the old long page of Drive and rule forms.
 */
function Overview({ client, summary, inboxNew, phone }: { client: ClientSummary; summary: Summary | null; inboxNew: number | null; phone: boolean }) {
  const [m, setM] = useState<DmMetricsView | null>(null);
  usePageHead(phone ? null : { sub: `DMs, automations and auto-post for ${client.name}, in one place.` });
  useEffect(() => {
    let live = true;
    api
      .get<DmMetricsView>(`/clients/${client.id}/dm/metrics?range=7`)
      .then((r) => live && setM(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client.id]);
  const s = summary;
  const cards: Array<{ id: WorkflowArea; icon: string; title: string; line: string; nums?: Array<[string, string]>; pill?: { cls: string; label: string } }> = [
    { id: "inbox", icon: "i-inbox", title: "Inbox", line: `Instagram and Messenger conversations for ${client.name}, in one list.`, nums: [["Unread", String(inboxNew ?? s?.unread ?? 0)], ["Contacts", (s?.contacts ?? 0).toLocaleString("en-US")]] },
    { id: "automations", icon: "i-bolt", title: "Automations", line: "Comment-to-DM, DM keywords, story replies and welcome messages.", pill: s?.liveAutomations ? { cls: "ok", label: `${s.liveAutomations} live` } : { cls: "", label: "None live" } },
    {
      id: "ai-replies",
      icon: "i-spark",
      title: "AI replies",
      line: s?.ai.on ? (s.ai.autopilot ? "Answers on its own where you chose it, and hands the chat to your team when it is not sure." : "Writes drafts for your team to send.") : "Off until you turn it on for an account.",
      pill: s?.ai.on ? (s.ai.autopilot ? { cls: "ok", label: "Answering" } : { cls: "info", label: "Drafts only" }) : { cls: "", label: "Off" },
    },
    {
      id: "auto-post",
      icon: "i-drive",
      title: "Auto-post",
      line: `Drive auto-post, plus ${s?.fanoutRules ?? 0} saved fan-out ${s?.fanoutRules === 1 ? "rule" : "rules"} (not running yet).`,
      pill: s ? (s.autoPost.tone === "off" ? { cls: "", label: "Off" } : s.autoPost.tone === "bad" ? { cls: "bad", label: "Needs a look" } : { cls: "ok", label: s.autoPost.label }) : undefined,
    },
  ];
  return (
    <div className={phone ? "ibx-wrap ph au wa" : "ibx-wrap au wa"} data-testid="workflows.overview">
      {m && (
        <div className={phone ? "wa-kg" : "wa-kpis"} aria-label="Last 7 days">
          {DM_METRIC_KEYS.map((k) => (
            <button key={k} type="button" className={phone ? undefined : "wa-kpi"} onClick={() => navigate("workflows", "metrics")}>
              <span className="k">{phone ? DM_METRIC_LABEL[k].short : DM_METRIC_LABEL[k].long}</span>
              <span className="v">
                {kpiText(k, m.kpis[k].value)}
                {!phone && m.kpis[k].delta && <span className={`wa-delta ${m.kpis[k].delta!.dir}`}>{m.kpis[k].delta!.text}</span>}
              </span>
              {phone && m.kpis[k].delta && <span className={`d ${m.kpis[k].delta!.dir}`}>{m.kpis[k].delta!.text}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={phone ? "wa-ovl" : "wa-ov"}>
        {cards.map((c) => (
          <section key={c.id} className={phone ? "mb-card wa-ovc" : "au-card"}>
            <div className="hd">
              <h3>
                <I name={c.icon} />
                {c.title}
              </h3>
              <span className="sp" />
              {c.pill && <span className={`au-pill${c.pill.cls ? ` ${c.pill.cls}` : ""}`}>{c.pill.label}</span>}
            </div>
            <p>{c.line}</p>
            {c.nums && (
              <div className="nums">
                {c.nums.map(([k, v]) => (
                  <div key={k}>
                    <b>{v}</b>
                    <span>{k}</span>
                  </div>
                ))}
              </div>
            )}
            <div>
              <a className={phone ? "mb-btn sm" : "ibx-btn"} {...linkProps("workflows", c.id)}>
                Open {c.title}
                <I name="i-chev-r" />
              </a>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default function WorkflowsScreen() {
  const { selectedClient } = useAppState();
  const isPhone = useIsPhone();
  const [inboxNew, setInboxNew] = useState<number | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const { section, item } = useRoute();
  const area = WORKFLOW_AREAS.find((a) => a.id === section)?.id ?? null;
  // The phone chip row scrolls to the area it is on, the one before peeking (as PageHeader does).
  const areaRow = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = areaRow.current;
    const on = row?.querySelector<HTMLElement>(".on");
    if (row && on) row.scrollLeft = Math.max(0, on.offsetLeft - 48);
  }, [area, isPhone]);
  // Contacts' "Open conversation" and AI replies' "Open" land on this thread in the Inbox.
  const [openThread, setOpenThread] = useState<string | null>(null);
  const openInInbox = useCallback((threadId: string) => {
    setOpenThread(threadId);
    navigate("workflows", "inbox");
  }, []);
  // The rail's counts (unread, live automations, AI, contacts, auto-post): one small read per brand and area.
  const clientId = selectedClient?.id;
  useEffect(() => {
    if (!clientId) return setSummary(null);
    let live = true;
    api
      .get<Summary>(`/clients/${clientId}/dm/summary`)
      .then((r) => {
        if (!live) return;
        setSummary(r);
        // The Inbox reports its own count while it is open.
        if (area !== "inbox") setInboxNew(r.unread);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clientId, area]);

  const none = (what: string) => <Empty screen="workflows" title="No brand selected" hint={`Pick a brand in the dock to see its ${what}.`} />;
  const body = (phone: boolean) =>
    !selectedClient ? (
      none("workflows")
    ) : area === "inbox" ? (
      <Inbox client={selectedClient} onUnread={setInboxNew} initialThreadId={openThread} />
    ) : area === "contacts" ? (
      <Contacts client={selectedClient} onOpenThread={openInInbox} />
    ) : area === "automations" ? (
      <Automations client={selectedClient} />
    ) : area === "ai-replies" ? (
      <AiReplies client={selectedClient} onOpenThread={openInInbox} />
    ) : area === "metrics" ? (
      <Metrics client={selectedClient} />
    ) : area === "auto-post" ? (
      <AutoPost client={selectedClient} />
    ) : (
      <Overview client={selectedClient} summary={summary} inboxNew={inboxNew} phone={phone} />
    );

  if (isPhone) {
    // Phone: the area chips under the title (mockups 02a, 03 to 06), the Inbox
    // chip carrying the unread count. The automation editor is a deeper page
    // (Back in the app bar, no chips).
    const areaRows: Array<{ id: WorkflowArea | null; label: string }> = [{ id: null, label: "Overview" }, ...WORKFLOW_AREAS];
    return (
      <section className="screen active mb-page fl-page" data-screen="workflows" data-state={selectedClient ? "ready" : "empty"} data-area={area ?? "overview"}>
        {area === null && <p className="mb-sub mb-subonly">DMs, automations and auto-post for {selectedClient?.name ?? "this brand"}, in one place.</p>}
        {!item && (
          <nav className="mb-chips wf-areas" aria-label="Workflow areas" ref={areaRow}>
            {areaRows.map((r) => (
              <a
                key={r.id ?? "overview"}
                className={"mb-chip" + (r.id === area ? " on" : "")}
                aria-current={r.id === area ? "page" : undefined}
                {...linkProps("workflows", r.id)}
                data-testid={"workflows.area." + (r.id ?? "overview")}
              >
                {r.label}
                {r.id === "inbox" && !!inboxNew && (
                  <span className="cnt">
                    {inboxNew}
                    <span className="vh"> new</span>
                  </span>
                )}
              </a>
            ))}
          </nav>
        )}
        {body(true)}
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="workflows" data-state={selectedClient ? "ready" : "empty"} data-area={area ?? "overview"}>
      <div className={`wfr${item ? " slim" : ""}`}>
        <WorkflowRail area={area} client={selectedClient} inboxNew={inboxNew} summary={summary} mini={!!item} />
        <div className="wfr-body">{body(false)}</div>
      </div>
    </section>
  );
}
