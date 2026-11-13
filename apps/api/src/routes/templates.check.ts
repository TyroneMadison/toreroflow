// W5 templates through the real auth hook, database stubbed: the operator
// and Polly read, apply and edit; any other bot reads and applies only as far
// as its BotIdentity scopes allow (none by default) and never edits. Apply
// prefills a draft; cadence suggestions come from posting history.
import assert from "node:assert/strict";
import { suggestCadence } from "../workflow/cadence";

// ---- Cadence, pure ----
// Wed Oct 28 2026, noon ET. The window is the 8 full weeks Aug 31 to Oct 19.
const now = new Date("2026-10-28T16:00:00Z");
const etEdt = (ymd: string, hour: number) => new Date(`${ymd}T${String(hour + 4).padStart(2, "0")}:00:00Z`);
const mondays = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
const history = [
  // Mon 6 PM ET, 6 of 8 weeks: a regular slot, missed Sep 7 and Oct 12.
  ...mondays.filter((m) => m !== "2026-09-07" && m !== "2026-10-12").map((m) => ({ at: etEdt(m, 18), views: 100 })),
  // Fri noon ET twice, far more views.
  { at: etEdt("2026-09-04", 12), views: 5000 },
  { at: etEdt("2026-09-25", 12), views: 3000 },
  // Outside the window: before it, and this (partial) week.
  { at: etEdt("2026-08-20", 9), views: 99999 },
  { at: etEdt("2026-10-26", 9), views: 99999 },
];
const c = suggestCadence("c1", history, now);
assert.equal(c.postsPerWeek, 1, "8 posts over 8 weeks");
assert.equal(c.cadence, "1 per week, Mon");
assert.deepEqual(c.missedSlots, [
  { day: "Mon", time: "18:00", weekOf: "2026-09-07" },
  { day: "Mon", time: "18:00", weekOf: "2026-10-12" },
]);
assert.deepEqual(c.bestTimes, [
  { day: "Fri", time: "12:00", posts: 2, avgViews: 4000 },
  { day: "Mon", time: "18:00", posts: 6, avgViews: 100 },
]);
assert.deepEqual(suggestCadence("c1", [], now), { brandId: "c1", postsPerWeek: 0, bestTimes: [], missedSlots: [], cadence: "" });
// Winter time: Mon Dec 7 2026, 6 PM EST is 23:00 UTC and still Mon 18:00.
const winter = suggestCadence("c1", [{ at: new Date("2026-12-07T23:00:00Z"), views: null }], new Date("2026-12-16T12:00:00Z"));
assert.deepEqual(winter.bestTimes, [{ day: "Mon", time: "18:00", posts: 1, avgViews: null }]);

// ---- Routes ----
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { templateRoutes } = await import("./templates");

type Row = Record<string, any>;
const clients = [
  { id: "c1", agencyId: "agencyA" },
  { id: "c2", agencyId: "agencyB" },
];
const templates: Row[] = [
  { id: "tpl1", clientId: "c1", agencyId: "agencyA", scope: "brand", name: "Weekly drop", platforms: ["youtube", "instagram", "facebook"], captionPattern: "New drop.", hashtags: ["cars", "#dud"], coverStyle: "bold", postTimes: ["18:00"], cadence: "3 per week", createdAt: new Date(1) },
  { id: "tplB", clientId: "c2", agencyId: "agencyB", scope: "client", name: "Other agency", platforms: ["tiktok"], captionPattern: "", hashtags: [], coverStyle: "", postTimes: [], cadence: "", createdAt: new Date(2) },
];
const assets = [
  { id: "vid1", clientId: "c1", draftCopy: { name: "M3 price reveal" } },
  { id: "vid9", clientId: "c2", draftCopy: null },
];
const bots: Record<string, string[]> = { reader: ["templates:read"], applier: ["templates:read", "templates:apply"] };
const agencyOf = (clientId: string) => clients.find((x) => x.id === clientId)?.agencyId;
const strip = ({ agencyId: _a, ...t }: Row) => t;

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("botIdentity", {
  findUnique: async ({ where }: { where: { agencyId_name: { name: string } } }) => {
    const scopes = bots[where.agencyId_name.name];
    return scopes ? { fullAccess: false, scopes } : null;
  },
});
stub("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
    clients.find((x) => x.id === where.id && x.agencyId === where.agencyId) ?? null,
});
stub("template", {
  findMany: async ({ where }: { where: { client: { agencyId: string }; clientId?: string } }) =>
    templates.filter((t) => t.agencyId === where.client.agencyId && (!where.clientId || t.clientId === where.clientId)).map(strip),
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) => {
    const t = templates.find((x) => x.id === where.id && x.agencyId === where.client.agencyId);
    return t ? strip(t) : null;
  },
  create: async ({ data }: { data: Row }) => {
    const t = { id: `tpl${templates.length + 1}`, agencyId: agencyOf(data.clientId), createdAt: new Date(), ...data };
    templates.push(t);
    return strip(t);
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const t = templates.find((x) => x.id === where.id)!;
    Object.assign(t, data, { agencyId: agencyOf(data.clientId) });
    return strip(t);
  },
  delete: async ({ where }: { where: { id: string } }) => templates.splice(templates.findIndex((x) => x.id === where.id), 1),
});
stub("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; clientId: string } }) =>
    assets.find((a) => a.id === where.id && a.clientId === where.clientId) ?? null,
});
// Two targets of one post (a fan-out) and a post with no metrics yet.
const recent = new Date(Date.now() - 14 * 86_400_000);
stub("postTarget", {
  findMany: async () => [
    { postId: "p1", publishedAt: recent, postMetrics: [{ views: 100 }] },
    { postId: "p1", publishedAt: new Date(recent.getTime() + 60_000), postMetrics: [{ views: 50 }] },
  ],
});

const app = Fastify();
await app.register(jwt, { secret: "templates-check" });
await app.register(templateRoutes);
const as = (extra: object = {}) => `Bearer ${app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra })}`;
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, who: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: who }, ...(payload ? { payload } : {}) });
const BODY = { scope: "brand", brandId: "c1", name: "Shorts", platforms: ["tiktok"], captionPattern: "Watch.", hashtags: ["x"], coverStyle: "", postTimes: ["09:30"], cadence: "" };
const APPLY = { videoId: "vid1", postAt: "2026-11-02T23:00:00.000Z" };

const operator = as();
const polly = as({ role: "bot", bot: "polly" });
const nova = as({ role: "bot", bot: "nova" });
const reader = as({ role: "bot", bot: "reader" });
const applier = as({ role: "bot", bot: "applier" });
const viewer = as({ role: "viewer" });

// The operator: list (own agency only, unknown platforms dropped), CRUD, apply.
let res = await call("GET", "/templates", operator);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json().templates.map((t: Row) => t.id), ["tpl1"]);
assert.deepEqual(res.json().templates[0].platforms, ["youtube", "instagram"]);
assert.equal(res.json().templates[0].brandId, "c1");
res = await call("POST", "/templates", operator, BODY);
assert.equal(res.statusCode, 200, res.body);
const created = res.json().id;
assert.equal((await call("PUT", `/templates/${created}`, operator, { ...BODY, name: "Shorts v2" })).json().name, "Shorts v2");
assert.equal((await call("POST", "/templates", operator, { ...BODY, postTimes: ["25:00"] })).statusCode, 400);
assert.equal((await call("POST", "/templates", operator, { ...BODY, brandId: "c2" })).statusCode, 404, "a brand of another agency");
assert.equal((await call("PUT", "/templates/tplB", operator, BODY)).statusCode, 404, "a template of another agency");

res = await call("POST", "/templates/tpl1/apply", operator, APPLY);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), {
  id: "template-tpl1-vid1",
  brandId: "c1",
  videoId: "vid1",
  caption: "New drop.\n\n#cars #dud",
  title: "M3 price reveal",
  postAt: "2026-11-02T23:00:00.000Z",
  targets: [
    { platform: "youtube", overrides: {} },
    { platform: "instagram", overrides: {} },
  ],
});
assert.equal((await call("POST", "/templates/tpl1/apply", operator, { ...APPLY, videoId: "vid9" })).statusCode, 404, "a video of another brand");
assert.equal((await call("POST", "/templates/tpl1/apply", operator, { videoId: "vid1" })).statusCode, 400);

res = await call("GET", "/templates/cadence?brandId=c1", operator);
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().brandId, "c1");
assert.equal(res.json().bestTimes[0].avgViews, 150, "a fan-out counts once, views summed");
assert.equal(res.json().bestTimes[0].posts, 1);
assert.equal((await call("GET", "/templates/cadence?brandId=c2", operator)).statusCode, 404);

// Polly (full access): everything the operator can.
assert.equal((await call("GET", "/templates", polly)).statusCode, 200);
assert.equal((await call("POST", "/templates/tpl1/apply", polly, APPLY)).statusCode, 200);
res = await call("PUT", `/templates/${created}`, polly, { ...BODY, name: "Polly edit" });
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().name, "Polly edit");
assert.equal((await call("POST", "/templates", polly, BODY)).statusCode, 200);
assert.equal((await call("DELETE", `/templates/${created}`, polly)).statusCode, 200);
assert.equal(templates.some((t) => t.id === created), false);

// A bot with templates:read reads, nothing more.
assert.equal((await call("GET", "/templates", reader)).statusCode, 200);
assert.equal((await call("GET", "/templates/cadence?brandId=c1", reader)).statusCode, 200);
assert.equal((await call("POST", "/templates/tpl1/apply", reader, APPLY)).statusCode, 403);
assert.equal((await call("POST", "/templates", reader, BODY)).statusCode, 403);

// A bot with templates:apply applies too, and still never edits.
assert.equal((await call("POST", "/templates/tpl1/apply", applier, APPLY)).statusCode, 200);
assert.equal((await call("POST", "/templates", applier, BODY)).statusCode, 403);
assert.equal((await call("PUT", "/templates/tpl1", applier, BODY)).statusCode, 403);
assert.equal((await call("DELETE", "/templates/tpl1", applier)).statusCode, 403);

// Any other bot has no scopes by default: nothing at all. A viewer neither.
const before = templates.length;
for (const who of [nova, viewer]) {
  assert.equal((await call("GET", "/templates", who)).statusCode, 403);
  assert.equal((await call("GET", "/templates/cadence?brandId=c1", who)).statusCode, 403);
  assert.equal((await call("POST", "/templates/tpl1/apply", who, APPLY)).statusCode, 403);
  assert.equal((await call("POST", "/templates", who, BODY)).statusCode, 403);
  assert.equal((await call("PUT", "/templates/tpl1", who, BODY)).statusCode, 403);
  assert.equal((await call("DELETE", "/templates/tpl1", who)).statusCode, 403);
}
assert.equal(templates.length, before, "nothing a refused caller did stuck");
assert.equal(templates.find((t) => t.id === "tpl1")!.name, "Weekly drop");

await app.close();
console.log("templates.check: all checks passed");
