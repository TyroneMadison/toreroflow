// W3 upload queue through the real auth hook, database and pg-boss stubbed:
// rush goes first, reorder persists position, the worker sees the order as
// job priority, and nothing touches a scheduled time (so the calendar and
// the daily counter, which read scheduledAt, cannot move).
import assert from "node:assert/strict";
import { uploadPriority } from "@toreroflow/db";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { queueRoutes } = await import("./queue");

const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
type Target = { id: string; status: string; scheduledAt: Date };
type Row = { id: string; agencyId: string; queuePriority: "rush" | "normal"; queuePosition: number | null; targets: Target[] };
const posts: Row[] = [
  { id: "urus", agencyId: "agencyA", queuePriority: "normal", queuePosition: null, targets: [{ id: "t-urus", status: "scheduled", scheduledAt: at(18) }] },
  { id: "promo", agencyId: "agencyA", queuePriority: "normal", queuePosition: null, targets: [{ id: "t-promo-ig", status: "scheduled", scheduledAt: at(14) }, { id: "t-promo-yt", status: "publishing", scheduledAt: at(14) }] },
  { id: "m3", agencyId: "agencyA", queuePriority: "normal", queuePosition: null, targets: [{ id: "t-m3", status: "scheduled", scheduledAt: at(22) }] },
  { id: "other", agencyId: "agencyB", queuePriority: "normal", queuePosition: null, targets: [{ id: "t-other", status: "scheduled", scheduledAt: at(1) }] },
];
const slotsBefore = JSON.stringify(posts.map((p) => p.targets));

const writes: string[] = [];
const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("post", {
  findMany: async ({ where }: { where: { client: { agencyId: string } } }) =>
    structuredClone(posts.filter((p) => p.agencyId === where.client.agencyId)),
  update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    assert.deepEqual(Object.keys(data).filter((k) => k !== "queuePosition" && k !== "queuePriority"), [], "only upload order is written");
    writes.push(`post ${where.id} ${JSON.stringify(data)}`);
    Object.assign(posts.find((p) => p.id === where.id)!, data);
  },
});
stub("$transaction", async (ops: Promise<unknown>[]) => Promise.all(ops));
stub("postTarget", new Proxy({}, { get: () => () => assert.fail("no PostTarget is ever written") }));
stub("botIdentity", { findUnique: async () => null });

const jobs: Record<string, number> = {};
const app = Fastify();
await app.register(jwt, { secret: "queue-check" });
await app.register(queueRoutes, {
  setPriority: async (queue: string, key: string, priority: number) => {
    assert.equal(queue, "publish");
    jobs[key] = priority;
  },
});
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const req = (method: "GET" | "PATCH", url: string, payload?: object, t = token()) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });
const order = async (t?: string) => (await req("GET", "/queue", undefined, t)).json().items.map((i: { id: string }) => i.id);

// Default: earliest slot first; another agency's posts never show.
let res = await req("GET", "/queue");
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json().items.map((i: { id: string }) => i.id), ["promo", "urus", "m3"]);
assert.equal(res.json().items[0].state, "uploading");
assert.equal(res.json().items[1].state, "queued");

// Rush jumps ahead, and its queued publish job outranks every normal one.
res = await req("PATCH", "/queue/m3/priority", { priority: "rush" });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json().items.map((i: { id: string }) => i.id), ["m3", "promo", "urus"]);
assert.equal(res.json().items[0].priority, "rush");
assert.equal(jobs["t-m3"], uploadPriority("rush", null));
assert.ok(jobs["t-m3"]! > uploadPriority("normal", 0));

// Reorder persists position, re-ranks only queued jobs, and rush stays first.
res = await req("PATCH", "/queue/reorder", { ids: ["urus", "promo", "m3"] });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(posts.slice(0, 3).map((p) => [p.id, p.queuePosition]), [["urus", 0], ["promo", 1], ["m3", 2]], "positions are stored");
assert.deepEqual(await order(), ["m3", "urus", "promo"], "rush first, then the stored order");
assert.equal(jobs["t-urus"], uploadPriority("normal", 0));
assert.equal(jobs["t-promo-ig"], uploadPriority("normal", 1));
assert.equal("t-promo-yt" in jobs, false, "a job already uploading is left alone");
assert.ok(jobs["t-m3"]! > jobs["t-urus"]! && jobs["t-urus"]! > jobs["t-promo-ig"]!, "the worker fetches rush, then position");

// Back to normal: the stored position decides again.
await req("PATCH", "/queue/m3/priority", { priority: "normal" });
assert.deepEqual(await order(), ["urus", "promo", "m3"]);

// Calendar times, and so the calendar and daily counter, never changed.
assert.equal(JSON.stringify(posts.map((p) => p.targets)), slotsBefore);

// Refusals.
assert.equal((await req("PATCH", "/queue/reorder", { ids: [] })).statusCode, 400);
assert.equal((await req("PATCH", "/queue/reorder", { ids: ["urus", "urus"] })).statusCode, 400);
assert.equal((await req("PATCH", "/queue/reorder", { ids: ["other"] })).statusCode, 404, "another agency's post");
assert.equal((await req("PATCH", "/queue/m3/priority", { priority: "urgent" })).statusCode, 400);
assert.equal((await req("PATCH", "/queue/nope/priority", { priority: "rush" })).statusCode, 404);
assert.equal((await req("PATCH", "/queue/m3/priority", { priority: "rush" }, token({ role: "viewer" }))).statusCode, 403);
assert.equal((await req("PATCH", "/queue/m3/priority", { priority: "rush" }, token({ role: "bot", bot: "nova" }))).statusCode, 403, "other bots keep their scope");
assert.equal((await req("PATCH", "/queue/m3/priority", { priority: "rush" }, token({ role: "bot", bot: "polly" }))).statusCode, 200, "Polly has full access");

await app.close();
console.log("queue.check: all checks passed");
