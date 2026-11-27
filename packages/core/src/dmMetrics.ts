/**
 * Workflows > Metrics (F5): how DMs, automations and AI replies did, computed
 * from the Dm* rows alone (GET /clients/:id/dm/metrics). Pure, so the numbers
 * are checked without a database (dmMetrics.check.ts).
 *
 * Messages are counted where we hold them: native Instagram threads. Zernio
 * threads (Messenger, and Instagram before the Meta app connect) count as
 * people by their last message time; their messages stay at Zernio.
 */

export const DM_METRIC_RANGES = ["7", "30", "90", "all"] as const;
export type DmMetricRange = (typeof DM_METRIC_RANGES)[number];
export const DM_METRIC_KEYS = ["received", "people", "contacts", "reach", "replyRate", "ctr"] as const;
export type DmMetricKey = (typeof DM_METRIC_KEYS)[number];

export const DM_METRIC_LABEL: Record<DmMetricKey, { long: string; short: string; chart: string }> = {
  received: { long: "Messages received", short: "Received", chart: "Messages received per day" },
  people: { long: "People who messaged", short: "People", chart: "People who messaged per day" },
  contacts: { long: "New contacts", short: "New contacts", chart: "New contacts per day" },
  reach: { long: "Automation reach", short: "Reach", chart: "People an automation messaged per day" },
  replyRate: { long: "Reply rate", short: "Reply rate", chart: "Reply rate after an automation DM, per day" },
  ctr: { long: "CTR", short: "CTR", chart: "Link click-through per day" },
};

const DAY = 24 * 3600_000;
/** How far back "All time" reads. ponytail: a year; an archive table if anyone needs more. */
export const DM_METRIC_ALL_DAYS = 365;

export interface DmMetricsInput {
  now: Date;
  range: DmMetricRange;
  /** Native messages from the earliest date the period, the comparison and the chart need. */
  messages: Array<{ at: Date; dir: "in" | "out"; contact: string; failed?: boolean }>;
  /** Zernio threads by their last message. */
  zernioThreads: Array<{ at: Date; id: string }>;
  contacts: Array<{ at: Date }>;
  /** Automation runs (tests left out by the caller). */
  runs: Array<{ at: Date; sentAt: Date | null; status: string; trigger: string; automationId: string | null; contact: string; clicks: number; reason: string | null }>;
  /** Threads that began in the period, with what their first message was. */
  threads: Array<{ createdAt: Date; platform: "instagram" | "facebook"; contact: string; firstKind: "story_reply" | "story_mention" | "dm" | null }>;
  drafts: Array<{ at: Date; status: string; sentHow: string | null; costCents: number }>;
  automations: Array<{ id: string; name: string; status: string }>;
}

export interface DmMetricDelta {
  dir: "up" | "down" | "flat";
  text: string;
}

export interface DmMetricsView {
  range: DmMetricRange;
  from: string;
  to: string;
  /** Null for All time: there is nothing before to compare with. */
  prevFrom: string | null;
  kpis: Record<DmMetricKey, { value: number | null; prev: number | null; delta: DmMetricDelta | null }>;
  chart: { from: string; days: number; shadeFrom: number; series: Record<DmMetricKey, { a: Array<number | null>; b?: number[] }> };
  delivery: { total: number; sends: number; outsideWindow: number; cannotGet: number; hourly: number; other: number };
  funnel: Array<{ key: string; label: string; n: number; pct: number | null }>;
  started: Array<{ key: string; label: string; n: number; pct: number }>;
  startedTotal: number;
  top: Array<{ id: string; name: string; status: string; runs: number; ctr: number | null; spark: number[] }>;
  replies: { medianResponseSec: number | null; responded: number };
  ai: { drafts: number; sentAsIs: number; edited: number; autoSent: number; handedOff: number; discarded: number; costCents: number };
  /** Nothing at all in the period: the screen shows its empty state. */
  empty: boolean;
}

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

/** The period, the one before it, and the chart's window. */
export function dmMetricsWindow(range: DmMetricRange, now: Date) {
  const days = range === "all" ? DM_METRIC_ALL_DAYS : Number(range);
  const to = now;
  const from = new Date(startOfDay(now).getTime() - (days - 1) * DAY);
  const prevFrom = range === "all" ? null : new Date(from.getTime() - days * DAY);
  // The chart always shows at least 30 days (mockup: "last 30 days, this week shaded"), at most 90.
  const chartDays = Math.min(90, Math.max(30, days));
  const chartFrom = new Date(startOfDay(now).getTime() - (chartDays - 1) * DAY);
  const earliest = new Date(Math.min(chartFrom.getTime(), (prevFrom ?? from).getTime()));
  return { days, from, to, prevFrom, chartDays, chartFrom, earliest, shadeFrom: Math.max(0, chartDays - days) };
}

const SENT = new Set(["sent", "gated"]);
const TRIGGERED = new Set(["sent", "gated", "failed", "expired", "repeat", "skipped", "queued", "dry_run"]);

export const STARTED_LABEL: Record<string, string> = {
  comment: "Comment keyword",
  story_reply: "Story reply",
  dm_keyword: "DM keyword",
  welcome: "Welcome message",
  story_mention: "Story mention",
  messenger: "Messenger",
  dm: "Direct message",
};

/** "+12%", "-1.2 pts". Rates compare in points, counts in percent. */
export function metricDelta(value: number | null, prev: number | null, rate: boolean): DmMetricDelta | null {
  if (value === null || prev === null) return null;
  if (rate) {
    const pts = (value - prev) * 100;
    if (Math.abs(pts) < 0.05) return { dir: "flat", text: "0 pts" };
    return { dir: pts > 0 ? "up" : "down", text: `${pts > 0 ? "+" : "-"}${Math.abs(pts) >= 10 ? Math.round(Math.abs(pts)) : Math.abs(pts).toFixed(1).replace(/\.0$/, "")} pts` };
  }
  if (prev === 0) return value === 0 ? { dir: "flat", text: "0%" } : null;
  const pct = ((value - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return { dir: "flat", text: "0%" };
  return { dir: pct > 0 ? "up" : "down", text: `${pct > 0 ? "+" : "-"}${Math.round(Math.abs(pct))}%` };
}

/** Everything the Metrics page draws, for one period. */
export function computeDmMetrics(i: DmMetricsInput): DmMetricsView {
  const w = dmMetricsWindow(i.range, i.now);
  const inP = (d: Date, a: Date, b: Date) => d >= a && d <= b;
  const cur = (d: Date) => inP(d, w.from, w.to);
  const prev = (d: Date) => !!w.prevFrom && d >= w.prevFrom && d < w.from;

  // When each contact last wrote to us, sorted, to tell whether they replied after a DM.
  const inbound = new Map<string, number[]>();
  for (const m of i.messages) if (m.dir === "in") (inbound.get(m.contact) ?? inbound.set(m.contact, []).get(m.contact)!).push(m.at.getTime());
  for (const list of inbound.values()) list.sort((a, b) => a - b);
  const repliedAfter = (contact: string, at: Date | null) => !!at && (inbound.get(contact) ?? []).some((t) => t > at.getTime());

  const kpisFor = (test: (d: Date) => boolean) => {
    const msgs = i.messages.filter((m) => test(m.at));
    const received = msgs.filter((m) => m.dir === "in").length;
    const people = new Set(msgs.filter((m) => m.dir === "in").map((m) => m.contact));
    for (const z of i.zernioThreads) if (test(z.at)) people.add(`z:${z.id}`);
    const contacts = i.contacts.filter((c) => test(c.at)).length;
    const sent = i.runs.filter((r) => SENT.has(r.status) && test(r.sentAt ?? r.at));
    const reach = new Set(sent.map((r) => r.contact)).size;
    const replied = sent.filter((r) => repliedAfter(r.contact, r.sentAt ?? r.at)).length;
    const clicked = sent.filter((r) => r.clicks > 0).length;
    return {
      received,
      people: people.size,
      contacts,
      reach,
      replyRate: sent.length ? replied / sent.length : null,
      ctr: sent.length ? clicked / sent.length : null,
    };
  };
  const now = kpisFor(cur);
  const before = w.prevFrom ? kpisFor(prev) : null;
  const kpis = {} as DmMetricsView["kpis"];
  for (const k of DM_METRIC_KEYS) {
    const rate = k === "replyRate" || k === "ctr";
    const p = before ? before[k] : null;
    kpis[k] = { value: now[k], prev: p, delta: metricDelta(now[k], p, rate) };
  }

  // Per-day series for the chart, one per number.
  const n = w.chartDays;
  const idx = (d: Date) => Math.floor((d.getTime() - w.chartFrom.getTime()) / DAY);
  const zeros = () => new Array<number>(n).fill(0);
  const recv = zeros();
  const sentS = zeros();
  const peopleDay = Array.from({ length: n }, () => new Set<string>());
  for (const m of i.messages) {
    const k = idx(m.at);
    if (k < 0 || k >= n) continue;
    if (m.dir === "in") (recv[k]++, peopleDay[k]!.add(m.contact));
    else if (!m.failed) sentS[k]++;
  }
  for (const z of i.zernioThreads) {
    const k = idx(z.at);
    if (k >= 0 && k < n) peopleDay[k]!.add(`z:${z.id}`);
  }
  const contactsDay = zeros();
  for (const c of i.contacts) {
    const k = idx(c.at);
    if (k >= 0 && k < n) contactsDay[k]++;
  }
  const reachDay = Array.from({ length: n }, () => new Set<string>());
  const sentDay = zeros();
  const repliedDay = zeros();
  const clickDay = zeros();
  for (const r of i.runs) {
    if (!SENT.has(r.status)) continue;
    const at = r.sentAt ?? r.at;
    const k = idx(at);
    if (k < 0 || k >= n) continue;
    reachDay[k]!.add(r.contact);
    sentDay[k]++;
    if (repliedAfter(r.contact, at)) repliedDay[k]++;
    if (r.clicks > 0) clickDay[k]++;
  }
  const rateOf = (a: number[], b: number[]) => a.map((x, k) => (b[k] ? x / b[k]! : null));

  // Delivery problems in the period.
  const runsP = i.runs.filter((r) => cur(r.at));
  const outsideWindow = runsP.filter((r) => r.status === "expired").length;
  const cannotGet = runsP.filter((r) => r.status === "failed" && /available|cannot|can't|blocked|restricted|551/i.test(r.reason ?? "")).length;
  const otherRun = runsP.filter((r) => r.status === "failed").length - cannotGet;
  const hourly = runsP.filter((r) => r.status === "queued" && /hourly/i.test(r.reason ?? "")).length;
  const failedMsgs = i.messages.filter((m) => m.failed && cur(m.at)).length;
  const sends = runsP.filter((r) => SENT.has(r.status)).length + i.messages.filter((m) => m.dir === "out" && !m.failed && cur(m.at)).length;

  // Where people drop off: the automation funnel.
  const triggered = runsP.filter((r) => TRIGGERED.has(r.status)).length;
  const got = i.runs.filter((r) => SENT.has(r.status) && cur(r.sentAt ?? r.at));
  const opened = got.filter((r) => r.clicks > 0).length;
  const replied = got.filter((r) => repliedAfter(r.contact, r.sentAt ?? r.at)).length;
  const of = (x: number) => (got.length ? x / got.length : null);
  const funnel = [
    { key: "triggered", label: "Triggered", n: triggered, pct: null },
    { key: "got", label: "Got the DM", n: got.length, pct: got.length ? 1 : null },
    { key: "opened", label: "Opened the link", n: opened, pct: of(opened) },
    { key: "replied", label: "Replied", n: replied, pct: of(replied) },
  ];

  // What started conversations: the automation that reached them first, else their first message.
  const firstRun = new Map<string, { at: number; trigger: string }>();
  for (const r of i.runs) {
    if (!SENT.has(r.status)) continue;
    const at = (r.sentAt ?? r.at).getTime();
    const had = firstRun.get(r.contact);
    if (!had || at < had.at) firstRun.set(r.contact, { at, trigger: r.trigger });
  }
  const startedN = new Map<string, number>();
  const startedThreads = i.threads.filter((t) => cur(t.createdAt));
  for (const t of startedThreads) {
    const run = firstRun.get(t.contact);
    const key =
      run && run.at <= t.createdAt.getTime() + 5 * 60_000 && STARTED_LABEL[run.trigger]
        ? run.trigger
        : t.platform === "facebook"
          ? "messenger"
          : t.firstKind === "story_reply" || t.firstKind === "story_mention"
            ? t.firstKind
            : "dm";
    startedN.set(key, (startedN.get(key) ?? 0) + 1);
  }
  const startedTotal = startedThreads.length;
  const started = [...startedN.entries()]
    .map(([key, n]) => ({ key, label: STARTED_LABEL[key] ?? key, n, pct: startedTotal ? n / startedTotal : 0 }))
    .sort((a, b) => b.n - a.n);

  // Top automations in the period, with a sparkline of runs per day.
  const sparkDays = Math.min(8, w.days);
  const sparkFrom = startOfDay(new Date(w.to.getTime() - (sparkDays - 1) * DAY)).getTime();
  const byAuto = new Map<string, { runs: number; sent: number; clicked: number; spark: number[] }>();
  for (const r of runsP) {
    if (!r.automationId || !TRIGGERED.has(r.status)) continue;
    const a = byAuto.get(r.automationId) ?? { runs: 0, sent: 0, clicked: 0, spark: new Array<number>(sparkDays).fill(0) };
    a.runs++;
    if (SENT.has(r.status)) a.sent++;
    if (r.clicks > 0) a.clicked++;
    const k = Math.floor((r.at.getTime() - sparkFrom) / DAY);
    if (k >= 0 && k < sparkDays) a.spark[k]!++;
    byAuto.set(r.automationId, a);
  }
  const names = new Map(i.automations.map((a) => [a.id, a]));
  const top = [...byAuto.entries()]
    .filter(([id]) => names.has(id))
    .map(([id, a]) => ({ id, name: names.get(id)!.name, status: names.get(id)!.status, runs: a.runs, ctr: a.sent ? a.clicked / a.sent : null, spark: a.spark }))
    .sort((x, y) => y.runs - x.runs)
    .slice(0, 5);

  // Response time: from their message to the next reply, median, in the period.
  const byContact = new Map<string, Array<{ at: number; dir: "in" | "out" }>>();
  for (const m of i.messages) if (!m.failed) (byContact.get(m.contact) ?? byContact.set(m.contact, []).get(m.contact)!).push({ at: m.at.getTime(), dir: m.dir });
  const waits: number[] = [];
  for (const list of byContact.values()) {
    list.sort((a, b) => a.at - b.at);
    let waitingSince: number | null = null;
    for (const m of list) {
      // A message nobody answered within the 24h window was missed, not slow: the wait starts again.
      if (m.dir === "in") waitingSince = waitingSince === null || m.at - waitingSince > DAY ? m.at : waitingSince;
      else if (waitingSince !== null) {
        if (m.at >= w.from.getTime() && m.at <= w.to.getTime()) waits.push((m.at - waitingSince) / 1000);
        waitingSince = null;
      }
    }
  }
  waits.sort((a, b) => a - b);
  const median = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2]! : (waits[waits.length / 2 - 1]! + waits[waits.length / 2]!) / 2) : null;

  const draftsP = i.drafts.filter((d) => cur(d.at));
  const ai = {
    drafts: draftsP.filter((d) => d.status !== "skipped" && d.status !== "failed" && d.status !== "handoff").length,
    sentAsIs: draftsP.filter((d) => d.status === "sent" && d.sentHow === "as_is").length,
    edited: draftsP.filter((d) => d.status === "sent" && d.sentHow === "edited").length,
    autoSent: draftsP.filter((d) => d.status === "sent" && d.sentHow === "auto").length,
    handedOff: draftsP.filter((d) => d.status === "handoff").length,
    discarded: draftsP.filter((d) => d.status === "discarded").length,
    costCents: draftsP.reduce((a, d) => a + d.costCents, 0),
  };

  const empty = !now.received && !now.people && !now.contacts && !triggered && !draftsP.length;
  return {
    range: i.range,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    prevFrom: w.prevFrom?.toISOString() ?? null,
    kpis,
    chart: {
      from: w.chartFrom.toISOString(),
      days: n,
      shadeFrom: w.shadeFrom,
      series: {
        received: { a: recv, b: sentS },
        people: { a: peopleDay.map((s) => s.size) },
        contacts: { a: contactsDay },
        reach: { a: reachDay.map((s) => s.size) },
        replyRate: { a: rateOf(repliedDay, sentDay) },
        ctr: { a: rateOf(clickDay, sentDay) },
      },
    },
    delivery: { total: outsideWindow + cannotGet + otherRun + hourly + failedMsgs, sends, outsideWindow, cannotGet, hourly, other: otherRun + failedMsgs },
    funnel,
    started,
    startedTotal,
    top,
    replies: { medianResponseSec: median, responded: waits.length },
    ai,
    empty,
  };
}
