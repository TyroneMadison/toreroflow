// Metrics (F5): the six numbers and their changes, the chart series, delivery
// problems, the funnel, what started conversations, top automations, the
// response time and the AI stats, on a small known data set.
import assert from "node:assert/strict";
import { computeDmMetrics, dmMetricsWindow, metricDelta, type DmMetricsInput } from "./dmMetrics";

const now = new Date("2026-11-27T15:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
const days = (d: number) => ago(d * 24);

const w = dmMetricsWindow("7", now);
assert.equal(w.chartDays, 30, "7 days still draws 30 days, the week shaded");
assert.equal(w.shadeFrom, 23);
assert.equal(dmMetricsWindow("90", now).chartDays, 90);
assert.equal(dmMetricsWindow("all", now).prevFrom, null, "all time has nothing to compare with");

assert.deepEqual(metricDelta(112, 100, false), { dir: "up", text: "+12%" });
assert.deepEqual(metricDelta(0.386, 0.398, true), { dir: "down", text: "-1.2 pts" });
assert.equal(metricDelta(5, 0, false), null, "from nothing there is no percent");
assert.equal(metricDelta(null, 0.2, true), null);

const input: DmMetricsInput = {
  now,
  range: "7",
  messages: [
    // this week: a writes twice and gets a reply after 10 minutes; b writes once
    { at: days(2), dir: "in", contact: "a" },
    { at: new Date(days(2).getTime() + 60_000), dir: "in", contact: "a" },
    { at: new Date(days(2).getTime() + 600_000), dir: "out", contact: "a" },
    { at: days(1), dir: "in", contact: "b" },
    { at: ago(2), dir: "in", contact: "c" },
    { at: ago(1), dir: "out", contact: "c" },
    { at: ago(1), dir: "out", contact: "c", failed: true },
    // the week before: one message
    { at: days(9), dir: "in", contact: "a" },
  ],
  zernioThreads: [{ at: days(3), id: "z1" }],
  contacts: [{ at: days(2) }, { at: days(1) }, { at: days(10) }],
  runs: [
    { at: days(3), sentAt: days(3), status: "sent", trigger: "comment", automationId: "au1", contact: "a", clicks: 1, reason: null },
    { at: days(3), sentAt: days(3), status: "sent", trigger: "comment", automationId: "au1", contact: "d", clicks: 0, reason: null },
    { at: days(2), sentAt: null, status: "expired", trigger: "dm_keyword", automationId: "au2", contact: "e", clicks: 0, reason: "The 24 hour reply window closed" },
    { at: days(2), sentAt: null, status: "failed", trigger: "comment", automationId: "au1", contact: "f", clicks: 0, reason: "This person isn't available right now (551)" },
    { at: days(1), sentAt: null, status: "queued", trigger: "comment", automationId: "au1", contact: "g", clicks: 0, reason: "Hourly limit reached, sends when there is room" },
    { at: days(1), sentAt: null, status: "ignored", trigger: "comment", automationId: null, contact: "h", clicks: 0, reason: "No keyword matched" },
    { at: days(9), sentAt: days(9), status: "sent", trigger: "comment", automationId: "au1", contact: "x", clicks: 0, reason: null },
  ],
  threads: [
    { createdAt: days(3), platform: "instagram", contact: "a", firstKind: "dm" },
    { createdAt: days(1), platform: "instagram", contact: "b", firstKind: "story_reply" },
    { createdAt: ago(2), platform: "facebook", contact: "c", firstKind: null },
  ],
  drafts: [
    { at: days(1), status: "sent", sentHow: "as_is", costCents: 3 },
    { at: days(1), status: "sent", sentHow: "edited", costCents: 2 },
    { at: days(1), status: "sent", sentHow: "auto", costCents: 2 },
    { at: days(1), status: "handoff", sentHow: null, costCents: 1 },
    { at: days(1), status: "discarded", sentHow: null, costCents: 2 },
    { at: days(20), status: "sent", sentHow: "auto", costCents: 9 },
  ],
  automations: [
    { id: "au1", name: "Free guide by comment", status: "live" },
    { id: "au2", name: "Booking link by DM", status: "live" },
  ],
};
const m = computeDmMetrics(input);
assert.equal(m.kpis.received.value, 4, "inbound native messages this week");
assert.equal(m.kpis.received.prev, 1);
assert.deepEqual(m.kpis.received.delta, { dir: "up", text: "+300%" });
assert.equal(m.kpis.people.value, 4, "a, b, c and one Zernio thread");
assert.equal(m.kpis.contacts.value, 2);
assert.equal(m.kpis.reach.value, 2, "a and d got an automation DM");
assert.equal(m.kpis.replyRate.value, 0.5, "a replied after the DM, d did not");
assert.equal(m.kpis.ctr.value, 0.5);
assert.equal(m.kpis.ctr.prev, 0, "the week before: one send, no click");

assert.equal(m.chart.days, 30);
assert.equal(m.chart.series.received.a.reduce((s: number, x) => s + (x ?? 0), 0), 5, "the chart holds 30 days, the week before included");
assert.equal(m.chart.series.received.b!.reduce((s, x) => s + x, 0), 2, "failed sends are not drawn as sent");

assert.equal(m.delivery.outsideWindow, 1);
assert.equal(m.delivery.cannotGet, 1);
assert.equal(m.delivery.hourly, 1);
assert.equal(m.delivery.other, 1, "the failed reply in a thread");
assert.equal(m.delivery.total, 4);

assert.deepEqual(m.funnel.map((f) => [f.key, f.n]), [["triggered", 5], ["got", 2], ["opened", 1], ["replied", 1]]);
assert.equal(m.funnel[2]!.pct, 0.5);

assert.equal(m.startedTotal, 3);
const started = Object.fromEntries(m.started.map((s) => [s.key, s.n]));
assert.deepEqual(started, { comment: 1, story_reply: 1, messenger: 1 }, "a came from the comment automation, b a story reply, c Messenger");

assert.equal(m.top[0]!.id, "au1");
assert.equal(m.top[0]!.runs, 4);
assert.equal(m.top[0]!.ctr, 0.5);
assert.equal(m.top[0]!.spark.length, 7);

assert.equal(m.replies.medianResponseSec, 2100, "a waited 10 minutes from the first message, c an hour: the median of the two");
assert.deepEqual(m.ai, { drafts: 4, sentAsIs: 1, edited: 1, autoSent: 1, handedOff: 1, discarded: 1, costCents: 10 });
assert.equal(m.empty, false);

const none = computeDmMetrics({ ...input, messages: [], zernioThreads: [], contacts: [], runs: [], threads: [], drafts: [] });
assert.equal(none.empty, true);
assert.equal(none.kpis.replyRate.value, null, "no sends, no rate");
assert.equal(none.top.length, 0);

console.log("dmMetrics.check: ok");
