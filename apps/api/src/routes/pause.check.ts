// Pause and Continue uploads through the real auth hook, database and queue
// stubbed: pause holds without touching posts, resume shifts by whole local
// days, clears the stamp, re-queues every held post. Bots read only.
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { publishQueue } = await import("../posts/requeue");
const { pauseRoutes } = await import("./pause");

const clients = [
  { id: "c1", agencyId: "agencyA", deletedAt: null, pausedAt: null as Date | null },
  { id: "c2", agencyId: "agencyB", deletedAt: null, pausedAt: null as Date | null },
];
const day = 86_400_000;
const start = Date.now() - 3 * day; // held posts that were due three days ago and on
const targets = [0, 1, 5].map((n) => ({ id: `t${n}`, clientId: "c1", status: "scheduled", scheduledAt: new Date(start + n * day) }));
targets.push({ id: "posted", clientId: "c1", status: "posted", scheduledAt: new Date(start - day) });
const before = targets.map((t) => t.scheduledAt.getTime());
const queued: Array<{ id: string; when: Date }> = [];

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
const clientStub = {
  findFirst: async ({ where }: any) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId && !c.deletedAt) ?? null,
  update: async ({ where, data }: any) => Object.assign(clients.find((c) => c.id === where.id)!, data),
};
const targetStub = {
  findMany: async ({ where }: any) =>
    targets.filter((t) => t.clientId === where.post.clientId && t.status === where.status).map((t) => ({ ...t })),
  count: async ({ where }: any) => targets.filter((t) => t.clientId === where.post.clientId && t.status === where.status).length,
  update: async ({ where, data }: any) => Object.assign(targets.find((t) => t.id === where.id)!, data),
};
stub("client", clientStub);
stub("postTarget", targetStub);
stub("$transaction", async (fn: any) => fn({ client: clientStub, postTarget: targetStub }));
stub("botIdentity", { findUnique: async () => null });
publishQueue.reschedule = (async (_q: string, _d: unknown, id: string, when: Date) => {
  queued.push({ id, when });
}) as never;

const app = Fastify();
await app.register(jwt, { secret: "pause-check" });
await app.register(pauseRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const req = (method: "GET" | "POST", url: string, t = token()) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` } });

assert.deepEqual((await req("GET", "/brands/c1/pause")).json(), { paused: false, pausedAt: null });
const paused = (await req("POST", "/brands/c1/pause")).json();
assert.equal(paused.paused, true);
assert.equal(paused.held, 3);
assert.deepEqual(targets.map((t) => t.scheduledAt.getTime()), before, "pausing moves nothing");
assert.equal((await req("GET", "/brands/c1/pause")).json().paused, true);

const bot = token({ role: "bot", bot: "nova" });
assert.equal((await req("GET", "/brands/c1/pause", bot)).statusCode, 200, "bots may read");
assert.equal((await req("POST", "/brands/c1/resume", bot)).statusCode, 403, "bots may not resume");
assert.equal((await req("POST", "/brands/c1/pause", token({ role: "viewer" }))).statusCode, 403, "viewer");
assert.equal((await req("POST", "/brands/c2/resume")).statusCode, 404, "other agency's brand");
assert.equal((await app.inject({ method: "GET", url: "/brands/c1/pause" })).statusCode, 401, "no token");

const resumed = (await req("POST", "/brands/c1/resume")).json();
assert.equal(resumed.paused, false);
assert.equal(resumed.held, 3);
assert.equal(resumed.moved, 3);
assert.equal(resumed.delta, 3);
assert.equal(clients[0]!.pausedAt, null, "stamp cleared");
const held = targets.filter((t) => t.status === "scheduled");
for (const t of held) assert.ok(t.scheduledAt.getTime() > Date.now(), `${t.id} is in the future`);
// Spacing kept (within an hour either way for a DST change in between).
const gap = (held[2]!.scheduledAt.getTime() - held[1]!.scheduledAt.getTime()) / day;
assert.ok(Math.abs(gap - 4) < 0.05, "four days apart, as before");
assert.equal(targets.find((t) => t.id === "posted")!.scheduledAt.getTime(), before[3], "posted is untouched");
assert.deepEqual(queued.map((q) => q.id).sort(), ["t0", "t1", "t5"], "every held post re-queued");
assert.equal(new Date(resumed.from).getTime(), Math.min(...held.map((t) => t.scheduledAt.getTime())));

assert.equal((await req("POST", "/brands/c1/resume")).json().moved, 0, "resuming twice is a no-op");
console.log("pause.check: ok");
await app.close();
