// Moving one platform of a post through the real auth hook and route, with
// the database and queue stubbed: a scheduled platform moves on its own and
// its job follows; anything posted, publishing, failed or sent to the client
// is refused with nothing moved or queued, including a post that starts
// publishing mid-request; past and invalid times are refused; other agencies'
// posts are invisible; bots other than Polly cannot reschedule.
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { publishQueue } = await import("../posts/requeue");
const { postRoutes } = await import("./posts");

const hour = 3_600_000;
const start = new Date(Date.now() + 24 * hour);
const targets = [
  { id: "tt", agencyId: "agencyA", status: "scheduled", scheduledAt: start },
  { id: "ig", agencyId: "agencyA", status: "scheduled", scheduledAt: start },
  ...["posted", "publishing", "failed", "reminded"].map((status) => ({ id: status, agencyId: "agencyA", status, scheduledAt: start })),
  { id: "racer", agencyId: "agencyA", status: "scheduled", scheduledAt: start },
  { id: "theirs", agencyId: "agencyB", status: "scheduled", scheduledAt: start },
];
const byId = (id: string) => targets.find((t) => t.id === id)!;
const queued: Array<{ id: string; when: Date }> = [];

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("postTarget", {
  findFirst: async ({ where }: any) => {
    const t = targets.find((x) => x.id === where.id && x.agencyId === where.post.client.agencyId);
    if (!t) return null;
    const seen = { ...t };
    // Starts publishing the instant after it is read.
    if (t.id === "racer") t.status = "publishing";
    return seen;
  },
  updateMany: async ({ where, data }: any) => {
    const hit = targets.filter((x) => x.id === where.id && x.status === where.status);
    for (const x of hit) Object.assign(x, data);
    return { count: hit.length };
  },
});
stub("botIdentity", { findUnique: async () => null });
publishQueue.reschedule = (async (_q: string, _d: unknown, id: string, when: Date) => {
  queued.push({ id, when });
}) as never;

const app = Fastify();
await app.register(jwt, { secret: "reschedule-check" });
await app.register(postRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const move = (id: string, scheduledAt: unknown, t = token()) =>
  app.inject({
    method: "PATCH",
    url: `/posts/targets/${id}/reschedule`,
    headers: { authorization: `Bearer ${t}` },
    payload: { scheduledAt },
  });

// One platform moves on its own; its sibling and the sibling's job stay put.
const later = new Date(start.getTime() + 3 * hour);
let res = await move("ig", later.toISOString());
assert.equal(res.statusCode, 200);
assert.equal(new Date(res.json().scheduledAt).getTime(), later.getTime());
assert.equal(byId("ig").scheduledAt.getTime(), later.getTime(), "instagram moved");
assert.equal(byId("tt").scheduledAt.getTime(), start.getTime(), "tiktok did not");
assert.deepEqual(queued, [{ id: "ig", when: later }], "only instagram's job moved, to the new time");

// Published or locked platforms never move, and nothing is queued for them.
for (const id of ["posted", "publishing", "failed", "reminded", "racer"]) {
  res = await move(id, later.toISOString());
  assert.equal(res.statusCode, 409, `${id} is refused`);
  assert.match(res.json().detail, /Only scheduled posts can move/);
  assert.equal(byId(id).scheduledAt.getTime(), start.getTime(), `${id} kept its time`);
}
assert.equal(queued.length, 1, "no job moved for a refused platform");

// The time rules still apply.
res = await move("tt", new Date(Date.now() - 2 * hour).toISOString());
assert.equal(res.statusCode, 400, "a past time is refused");
assert.match(res.json().detail, /already passed/);
assert.equal((await move("tt", "not a date")).statusCode, 400, "an invalid date is refused");
assert.equal((await move("tt", undefined)).statusCode, 400, "a missing date is refused");

// Scope and auth.
assert.equal((await move("theirs", later.toISOString())).statusCode, 404, "another agency's post");
assert.equal((await move("missing", later.toISOString())).statusCode, 404, "no such post");
assert.equal((await move("tt", later.toISOString(), token({ role: "bot", bot: "nova" }))).statusCode, 403, "bots cannot reschedule");
const anon = await app.inject({ method: "PATCH", url: "/posts/targets/tt/reschedule", payload: { scheduledAt: later.toISOString() } });
assert.equal(anon.statusCode, 401, "no token");
assert.equal(byId("tt").scheduledAt.getTime(), start.getTime(), "tiktok never moved");
assert.equal(queued.length, 1, "and nothing else was queued");

console.log("reschedule.check: ok");
await app.close();
