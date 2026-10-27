// Monthly client report: the numbers, the 1st-of-month rule, the kill switch
// (OFF builds a preview and never calls the mailer), one send per brand per
// month, and the routes through the real auth hook (Polly in, other bots out).
import assert from "node:assert/strict";

delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { DEFAULT_REPORT_JOB_CONFIG } = await import("@toreroflow/contracts");
const M = await import("./monthlyReport");
const { rawMessage } = await import("../mail/mailer");
const { monthlyReportRoutes } = await import("../routes/monthlyReport");
const { testApp } = await import("./testApp");

// ---- pure parts ----
assert.equal(M.reportMonthFor(new Date("2026-11-01T05:00:00Z")), "2026-10", "1am ET on Nov 1");
assert.equal(M.reportMonthFor(new Date("2026-11-01T03:00:00Z")), null, "still Oct 31 in New York");
assert.equal(M.reportMonthFor(new Date("2027-01-01T12:00:00Z")), "2026-12");
assert.equal(M.reportMonthFor(new Date("2026-11-02T12:00:00Z")), null);
assert.equal(M.monthBounds("2026-10").start.toISOString(), "2026-10-01T04:00:00.000Z");
assert.equal(M.monthBounds("2026-12").end.toISOString(), "2027-01-01T05:00:00.000Z");
assert.deepEqual(M.profileEmails(" A@x.com; b@y.co , not-an-email, a@x.com"), ["a@x.com", "b@y.co"]);
assert.deepEqual(M.profileEmails(null), []);

const start = new Date("2026-10-01T04:00:00Z");
const s = M.summarizeMonth({
  start,
  posted: [
    { postId: "p1", views: 100 },
    { postId: "p1", views: 50 },
    { postId: "p2", views: 120 },
    { postId: "p3", views: null },
  ],
  snapshots: [
    { socialAccountId: "ig", capturedAt: new Date("2026-09-30T00:00:00Z"), followers: 1000 },
    { socialAccountId: "ig", capturedAt: new Date("2026-10-31T00:00:00Z"), followers: 1040 },
    { socialAccountId: "ig", capturedAt: new Date("2026-10-15T00:00:00Z"), followers: 1020 },
    { socialAccountId: "tt", capturedAt: new Date("2026-10-05T00:00:00Z"), followers: 10 },
    { socialAccountId: "tt", capturedAt: new Date("2026-10-20T00:00:00Z"), followers: 15 },
    { socialAccountId: "yt", capturedAt: new Date("2026-10-20T00:00:00Z"), followers: null },
  ],
  upcoming: [
    { platform: "tiktok", scheduledAt: new Date("2026-11-05T15:00:00Z"), caption: "Second\nmore" },
    { platform: "instagram", scheduledAt: new Date("2026-11-03T15:00:00Z"), caption: null },
  ],
});
assert.equal(s.views, 270);
assert.equal(s.posts, 3);
assert.equal(s.topPostId, "p1");
assert.equal(s.followersGained, 45, "ig +40 against the last count before the month, tt +5 within it");
assert.deepEqual(s.nextMonthPlan, ["Nov 3, instagram", "Nov 5, tiktok: Second"]);
const decoded = Buffer.from(rawMessage("Toreronee@gmail.com", { to: "a@x.com", subject: "Hi", text: "Body" }), "base64url").toString();
assert.match(decoded, /^From: Toreronee@gmail.com\r\nTo: a@x.com\r\n/);

// ---- the job, on an in-memory database ----
const settings = new Map<string, unknown>();
const runs = new Map<string, Record<string, unknown>>();
const clients = [
  { id: "c1", agencyId: "A", name: "Dudley", contactEmail: "dud@x.com, ops@x.com", deletedAt: null },
  { id: "c2", agencyId: "A", name: "Caleb", contactEmail: null, deletedAt: null },
];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("agency", { findMany: async () => [{ id: "A" }] });
mock("appSetting", {
  findUnique: async ({ where }: { where: { agencyId_key: { agencyId: string; key: string } } }) => {
    const v = settings.get(`${where.agencyId_key.agencyId}|${where.agencyId_key.key}`);
    return v === undefined ? null : { value: v };
  },
  upsert: async ({ where, create }: { where: { agencyId_key: { agencyId: string; key: string } }; create: { value: unknown } }) => {
    settings.set(`${where.agencyId_key.agencyId}|${where.agencyId_key.key}`, create.value);
  },
});
mock("client", {
  findMany: async ({ where }: { where: { agencyId: string } }) => clients.filter((c) => c.agencyId === where.agencyId),
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
    clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
mock("postTarget", {
  findMany: async ({ where }: { where: { status: string; post: { clientId: string } } }) =>
    where.post.clientId !== "c1"
      ? []
      : where.status === "posted"
        ? [{ postId: "p1", postMetrics: [{ views: 900 }] }]
        : [{ platform: "youtube", scheduledAt: new Date("2026-11-10T15:00:00Z"), caption: "Walkaround" }],
});
mock("socialAccount", { findMany: async () => [] });
mock("metricSnapshot", { findMany: async () => [] });
const runKey = (w: { clientId_month: { clientId: string; month: string } }) => `${w.clientId_month.clientId}|${w.clientId_month.month}`;
mock("monthlyReportRun", {
  findUnique: async ({ where }: { where: { clientId_month: { clientId: string; month: string } } }) => {
    const r = runs.get(runKey(where));
    return r ? { id: `run-${runKey(where)}`, ...r } : null;
  },
  upsert: async ({ where, create, update }: { where: { clientId_month: { clientId: string; month: string } }; create: object; update: object }) => {
    const k = runKey(where);
    runs.set(k, { ...(runs.get(k) ?? create), ...update });
  },
});

const sent: { to: string; subject: string; text: string }[] = [];
const fake = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) };

// Kill switch OFF (the default): previews only, the mailer is never called.
let results = await M.runMonthlyReports("2026-10", fake);
assert.deepEqual(results.map((r) => r.status), ["preview", "preview"]);
assert.equal(sent.length, 0);
assert.equal(runs.get("c1|2026-10")!.status, "preview");
assert.deepEqual(runs.get("c1|2026-10")!.recipients, ["dud@x.com", "ops@x.com"]);

// ON, but the sender is not connected: nothing is sent, the brand is retried next run.
settings.set("A|report_job", { ...DEFAULT_REPORT_JOB_CONFIG, killSwitch: true });
results = await M.runMonthlyReports("2026-10", null);
assert.equal(results[0]!.status, "failed");
assert.equal(sent.length, 0);

// ON: every email on the profile gets it; a brand with no email is skipped.
results = await M.runMonthlyReports("2026-10", fake);
assert.deepEqual(results.map((r) => r.status), ["sent", "skipped"]);
assert.deepEqual(sent.map((m) => m.to), ["dud@x.com", "ops@x.com"]);
assert.equal(sent[0]!.subject, "Dudley: your October 2026 report");
assert.match(sent[0]!.text, /Views: 900/);
assert.match(sent[0]!.text, /Nov 10, youtube: Walkaround/);
assert.ok(runs.get("c1|2026-10")!.sentAt instanceof Date);

// A second run the same month never emails again.
results = await M.runMonthlyReports("2026-10", fake);
assert.equal(results[0]!.status, "already_sent");
assert.equal(sent.length, 2);

// A send failure is recorded, not thrown.
results = await M.runMonthlyReports("2026-09", { send: async () => { throw new Error("Gmail send 500"); } });
assert.equal(results[0]!.status, "failed");
assert.equal(runs.get("c1|2026-09")!.error, "Gmail send 500");

// ---- routes ----
settings.clear();
const { app, operator, polly, nova } = await testApp(monthlyReportRoutes);

let res = await app.inject({ method: "GET", url: "/reports/job-config", headers: operator });
assert.equal(res.statusCode, 200);
assert.equal(res.json().killSwitch, false, "OFF by default");

res = await app.inject({ method: "PUT", url: "/reports/job-config", headers: nova, payload: { ...DEFAULT_REPORT_JOB_CONFIG, killSwitch: true } });
assert.equal(res.statusCode, 403, "other bots cannot turn sending on");
res = await app.inject({ method: "PUT", url: "/reports/job-config", headers: operator, payload: { ...DEFAULT_REPORT_JOB_CONFIG, sender: "x@y.com" } });
assert.equal(res.statusCode, 400, "the sender is fixed");
res = await app.inject({ method: "PUT", url: "/reports/job-config", headers: polly, payload: { ...DEFAULT_REPORT_JOB_CONFIG, killSwitch: true } });
assert.equal(res.statusCode, 200, res.body);
assert.equal((settings.get("A|report_job") as { killSwitch: boolean }).killSwitch, true);

const before = sent.length;
res = await app.inject({ method: "GET", url: "/reports/monthly/c1/2026-10", headers: polly });
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().views, 900);
assert.equal(res.json().sentAt !== null, true);
assert.equal(sent.length, before, "the preview route never sends");
res = await app.inject({ method: "GET", url: "/reports/monthly/c1/2026-13", headers: operator });
assert.equal(res.statusCode, 400);
res = await app.inject({ method: "GET", url: "/reports/monthly/other/2026-10", headers: operator });
assert.equal(res.statusCode, 404);
res = await app.inject({ method: "GET", url: "/reports/monthly/c1/2026-10", headers: nova });
assert.equal(res.statusCode, 403);

await app.close();
console.log("monthlyReport.check: ok");
