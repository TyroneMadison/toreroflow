import {
  DM_AI_DELAYS,
  DM_AI_TOPIC_INFO,
  DM_METRIC_KEYS,
  DM_METRIC_LABEL,
  type DmAiAccountView,
  type DmAiOverview,
  type DmAiQueueRow,
  type DmAiSettings,
  type DmMetricKey,
  type DmMetricsView,
} from "@toreroflow/core";

/**
 * Workflows > AI replies, Metrics and Auto-post (F5): the copy and the small
 * sums the three screens draw, kept here so aiMetrics.check.ts can hold them
 * to the mockups (round 2 03, 05 and 06) without a browser.
 */

// ---------------------------------------------------------------------------
// AI replies
// ---------------------------------------------------------------------------

/** "Waits 20 to 90 seconds and shows typing" (mockup 03, How it answers). */
export function delaySummary(s: Pick<DmAiSettings, "replyDelayMinSec" | "replyDelayMaxSec" | "typing">, phone = false): string {
  const { replyDelayMinSec: a, replyDelayMaxSec: b } = s;
  const wait =
    b === 0
      ? "Replies at once"
      : b >= 120 && a % 60 === 0 && b % 60 === 0
        ? `Waits ${a / 60} to ${b / 60} minutes`
        : a === b
          ? `Waits ${b} seconds`
          : `Waits ${a} to ${b} seconds`;
  return phone || !s.typing ? wait : `${wait} and shows typing`;
}

export const delayPreset = (s: Pick<DmAiSettings, "replyDelayMinSec" | "replyDelayMaxSec">): string | null =>
  DM_AI_DELAYS.find((d) => d.min === s.replyDelayMinSec && d.max === s.replyDelayMaxSec)?.id ?? null;

export const delayChip = (s: Pick<DmAiSettings, "replyDelayMinSec" | "replyDelayMaxSec">): string =>
  s.replyDelayMaxSec === 0 ? "At once" : s.replyDelayMaxSec < 120 ? `${s.replyDelayMinSec} to ${s.replyDelayMaxSec} s` : `${Math.round(s.replyDelayMinSec / 60)} to ${Math.round(s.replyDelayMaxSec / 60)} min`;

/** "After 12 hours with no reply from you", or "Not on its own". */
export const resumeLabel = (h: number): string => (h === 0 ? "Not on its own: you turn it back on" : `After ${h} ${h === 1 ? "hour" : "hours"} with no reply from you`);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Instructions, 3 links, 3 lessons from handoffs". */
export function knowsSummary(s: Pick<DmAiSettings, "instructions" | "links" | "lessons">, phone = false): string {
  const parts = [
    ...(s.instructions.trim() ? ["Instructions"] : []),
    ...(s.links.length ? [plural(s.links.length, "link")] : []),
    ...(s.lessons.length ? [phone ? plural(s.lessons.length, "lesson") : `${plural(s.lessons.length, "lesson")} from handoffs`] : []),
  ];
  return parts.length ? parts.join(", ") : "Nothing yet: add what it should know";
}

/** "3 people and 6 more tagged friend". */
export function neverSummary(never: DmAiOverview["never"], phone = false): string {
  const people = never.off;
  const friends = never.friends;
  if (!people && !friends) return "Nobody yet. Anyone tagged friend is skipped";
  if (!people) return `${plural(friends, "person", "people")} tagged friend`;
  if (!friends) return plural(people, "person", "people");
  return `${plural(people, "person", "people")} and ${friends} ${phone ? "" : "more "}tagged friend`.replace("  ", " ");
}

/** "Prices and discounts, refunds, complaints and asking for a person". */
export function handoffSummary(s: Pick<DmAiSettings, "handoffTopics" | "handoffWords">): string {
  const names = s.handoffTopics.map((t) => DM_AI_TOPIC_INFO[t].label.toLowerCase());
  if (s.handoffWords.length) names.push(plural(s.handoffWords.length, "word") + " of your own");
  if (!names.length) return "Only when it is not sure";
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  return list.charAt(0).toUpperCase() + list.slice(1);
}

export interface AiBand {
  state: "on" | "drafts" | "off" | "stopped";
  title: string;
  pill: { cls: string; label: string };
  line: string;
}

/** The status band: on (some account sends on its own), drafts only, off, or stopped by the kill switch. */
export function aiBand(accounts: DmAiAccountView[], killedAt: string | null, brand: string): AiBand {
  const on = accounts.filter((a) => a.settings.enabled);
  const auto = on.filter((a) => a.settings.mode === "autopilot");
  const of = `${on.length} of ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
  const honest = `If someone asks, it says it is an assistant for ${brand}. It never pretends to be a person.`;
  if (!on.length) return { state: "off", title: "AI replies are off", pill: { cls: "", label: "Off" }, line: `Off for every account until you turn it on. ${honest}` };
  if (killedAt) return { state: "stopped", title: "AI sending is stopped", pill: { cls: "bad", label: "Stopped" }, line: `Nothing goes out on its own until you start it again. Drafts still come for ${of}.` };
  if (!auto.length) return { state: "drafts", title: "AI replies write drafts", pill: { cls: "info", label: "Drafts only" }, line: `On for ${of}. A person sends each reply. ${honest}` };
  return { state: "on", title: "AI replies are on", pill: { cls: "ok", label: "Answering" }, line: `On for ${of}. ${honest}` };
}

/** "No answer for 41 min" (desktop) or "41 min" (phone). */
export function waitText(since: string | null, now = Date.now(), phone = false): string {
  if (!since) return phone ? "" : "Waiting";
  const m = Math.max(1, Math.floor((now - Date.parse(since)) / 60_000));
  const t = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`;
  return phone ? t : `No answer for ${t}`;
}

/** The second line of a Needs you row: what they said, and why the AI is not on it. */
export function queueNote(r: DmAiQueueRow, accounts: DmAiAccountView[]): string {
  const said = r.preview ? `"${r.preview}"` : "";
  if (r.why === "handoff") return said || r.reason;
  const acct = accounts.find((a) => a.accountId === r.accountId);
  const why =
    r.platform === "facebook" && !acct?.settings.enabled
      ? "AI is off on Messenger"
      : r.aiOff
        ? "AI is off in this chat"
        : r.paused
          ? "Auto replies paused"
          : !acct?.settings.enabled
            ? "AI is off on this account"
            : "Not sure of the answer";
  return said ? `${said} ${why}` : why;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const fmtNum = (n: number | null): string => (n === null ? "n/a" : n.toLocaleString("en-US"));
export const fmtPct = (f: number | null): string => (f === null ? "n/a" : `${(f * 100).toFixed(1).replace(/\.0$/, "")}%`);
export const kpiText = (k: DmMetricKey, v: number | null): string => (k === "replyRate" || k === "ctr" ? fmtPct(v) : fmtNum(v));

/** "23 min", "1.5 h", "under a minute". */
export function durText(sec: number | null): string {
  if (sec === null) return "n/a";
  if (sec < 60) return "under a minute";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = sec / 3600;
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)} h`;
}

export interface ChartGeo {
  w: number;
  h: number;
  max: number;
  grid: Array<{ y: number; label: string }>;
  a: string;
  area: string;
  b: string | null;
  shadeX: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

/** "Nice" ceiling for the axis: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** The chart's lines (mockup 05: a filled line for the chosen number, a dashed one for sent). */
export function chartGeo(a: Array<number | null>, b: number[] | undefined, w: number, h: number, shadeFrom: number, rate: boolean, compact = false): ChartGeo {
  const top = compact ? 8 : 10;
  const bot = compact ? 20 : 26;
  const left = compact ? 2 : 34;
  const vals = [...a.filter((v): v is number => v !== null), ...(b ?? [])];
  const max = rate ? 1 : niceMax(Math.max(0, ...vals));
  const n = Math.max(1, a.length - 1);
  const x = (i: number) => left + (i * (w - left - (compact ? 2 : 8))) / n;
  const y = (v: number) => top + (1 - v / max) * (h - top - bot);
  const line = (arr: Array<number | null>) => {
    let d = "";
    let pen = false;
    arr.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const aLine = line(a);
  const firstI = a.findIndex((v) => v !== null);
  const lastI = a.length - 1 - [...a].reverse().findIndex((v) => v !== null);
  const area = aLine && firstI >= 0 ? `${aLine} L${x(lastI).toFixed(1)} ${y(0).toFixed(1)} L${x(firstI).toFixed(1)} ${y(0).toFixed(1)} Z` : "";
  const steps = [0, 0.25, 0.5, 0.75, 1];
  return {
    w,
    h,
    max,
    grid: steps.map((s) => ({ y: y(max * s), label: rate ? `${Math.round(s * 100)}%` : fmtNum(Math.round(max * s)) })),
    a: aLine,
    area,
    b: b ? line(b) : null,
    shadeX: x(shadeFrom),
    x,
    y,
  };
}

/** Export CSV (phone actions sheet): the six numbers, then the day by day series. */
export function metricsCsv(m: DmMetricsView, brand: string): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows: string[][] = [[`Metrics for ${brand}`, `${m.from.slice(0, 10)} to ${m.to.slice(0, 10)}`], [], ["Number", "This period", "Period before"]];
  for (const k of DM_METRIC_KEYS) rows.push([DM_METRIC_LABEL[k].long, kpiText(k, m.kpis[k].value), kpiText(k, m.kpis[k].prev)]);
  rows.push([], ["Day", "Received", "Sent", "People", "New contacts", "Reach"]);
  const from = Date.parse(m.chart.from);
  for (let i = 0; i < m.chart.days; i++) {
    rows.push([
      new Date(from + i * 86400000).toISOString().slice(0, 10),
      String(m.chart.series.received.a[i] ?? 0),
      String(m.chart.series.received.b?.[i] ?? 0),
      String(m.chart.series.people.a[i] ?? 0),
      String(m.chart.series.contacts.a[i] ?? 0),
      String(m.chart.series.reach.a[i] ?? 0),
    ]);
  }
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export const RANGE_LABEL: Record<string, { long: string; short: string; sub: string }> = {
  "7": { long: "7 days", short: "7 days", sub: "Last 7 days, compared with the 7 days before." },
  "30": { long: "30 days", short: "30", sub: "Last 30 days, compared with the 30 days before." },
  "90": { long: "90 days", short: "90", sub: "Last 90 days, compared with the 90 days before." },
  all: { long: "All time", short: "All", sub: "The last year." },
};

// ---------------------------------------------------------------------------
// Auto-post
// ---------------------------------------------------------------------------

/** A Drive video's pill, in the mockup's tones (06): scheduled info, caption drive, held paused, failed bad. */
export const VIDEO_PILL: Record<string, { cls: string; label: string; short?: string }> = {
  claimed: { cls: "drive", label: "Downloading" },
  downloaded: { cls: "drive", label: "Writing caption", short: "Caption" },
  dryrun: { cls: "", label: "Test only" },
  scheduled: { cls: "info", label: "Scheduled" },
  held: { cls: "paused", label: "Held" },
  skipped: { cls: "", label: "Skipped" },
  failed: { cls: "bad", label: "Failed" },
};
/** "Needs a look": the ones a person has to do something about. */
export const needsLook = (status: string): boolean => status === "held" || status === "failed";

/** The band's title, pill and line from the Drive run state (core driveRunState). */
export function driveBand(run: { tone: "ok" | "bad" | "off"; text: string } | null): { title: string; pill: { cls: string; label: string } | null; line: string } {
  if (!run) return { title: "Drive auto-post", pill: null, line: "Loading..." };
  const [label, ...rest] = run.text.split(". ");
  const line = rest.join(". ");
  if (run.tone === "off") return { title: "Drive auto-post is off", pill: { cls: "", label: "Off" }, line: "Paste a Drive folder link in Settings, tick an account, then Save." };
  if (run.tone === "bad") return { title: "Drive auto-post needs a look", pill: { cls: "bad", label: "Not working" }, line };
  if (label === "Starting") return { title: "Drive auto-post is starting", pill: { cls: "warn", label: "Starting" }, line };
  return { title: "Drive auto-post is running", pill: { cls: "ok", label: "Running" }, line };
}
