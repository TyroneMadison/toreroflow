// Calendar "posted to X" ticks through the real auth hook, database stubbed:
// PUT true then false round-trips, GET returns only the range asked for, the
// brand must be in the caller's agency, bad dates and viewers are refused.
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { xPostedRoutes } = await import("./xPosted");

const clients = [
  { id: "c1", agencyId: "agencyA", deletedAt: null },
  { id: "c2", agencyId: "agencyB", deletedAt: null },
];
let rows: Array<{ clientId: string; date: string }> = [{ clientId: "c2", date: "2026-10-28" }];

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("client", {
  findFirst: async ({ where }: any) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId && !c.deletedAt) ?? null,
});
stub("xPostedDay", {
  findMany: async ({ where }: any) =>
    rows
      .filter((r) => r.clientId === where.clientId && r.date >= where.date.gte && r.date <= where.date.lte)
      .sort((a, b) => a.date.localeCompare(b.date)),
  upsert: async ({ create }: any) => {
    if (!rows.some((r) => r.clientId === create.clientId && r.date === create.date)) rows.push(create);
  },
  deleteMany: async ({ where }: any) => {
    rows = rows.filter((r) => !(r.clientId === where.clientId && r.date === where.date));
  },
});
stub("botIdentity", { findUnique: async () => null });

const app = Fastify();
await app.register(jwt, { secret: "xposted-check" });
await app.register(xPostedRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const req = (method: "GET" | "PUT", url: string, payload?: object, t = token()) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });
const dates = async (from = "2026-10-26", to = "2026-11-01") =>
  (await req("GET", `/brands/c1/x-posted?from=${from}&to=${to}`)).json().dates;

assert.deepEqual(await dates(), [], "starts empty");
assert.equal((await req("PUT", "/brands/c1/x-posted/2026-10-28", { posted: true })).statusCode, 200);
assert.equal((await req("PUT", "/brands/c1/x-posted/2026-10-28", { posted: true })).statusCode, 200, "ticking twice is fine");
await req("PUT", "/brands/c1/x-posted/2026-11-05", { posted: true });
assert.deepEqual(await dates(), ["2026-10-28"], "range excludes days outside it, one row per day");
assert.deepEqual(await dates("2026-10-01", "2026-11-30"), ["2026-10-28", "2026-11-05"], "month range");

assert.deepEqual((await req("PUT", "/brands/c1/x-posted/2026-10-28", { posted: false })).json(), { date: "2026-10-28", posted: false });
assert.deepEqual(await dates(), [], "unticked");

assert.equal((await req("GET", "/brands/c2/x-posted?from=2026-10-01&to=2026-10-31")).statusCode, 404, "other agency's brand");
assert.equal((await req("PUT", "/brands/c2/x-posted/2026-10-28", { posted: false })).statusCode, 404, "cannot untick another agency's day");
assert.equal(rows.filter((r) => r.clientId === "c2").length, 1, "their row untouched");

assert.equal((await req("PUT", "/brands/c1/x-posted/2026-13-01", { posted: true })).statusCode, 400, "bad month");
assert.equal((await req("PUT", "/brands/c1/x-posted/2026-10-28", { posted: "yes" })).statusCode, 400, "posted must be boolean");
assert.equal((await req("GET", "/brands/c1/x-posted?from=oct")).statusCode, 400, "bad range");
assert.equal((await req("PUT", "/brands/c1/x-posted/2026-10-28", { posted: true }, token({ role: "viewer" }))).statusCode, 403, "viewer");
assert.equal((await app.inject({ method: "GET", url: "/brands/c1/x-posted?from=2026-10-01&to=2026-10-31" })).statusCode, 401, "no token");

console.log("xPosted.check: ok");
await app.close();
