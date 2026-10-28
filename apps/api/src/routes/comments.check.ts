// The comments inbox through the real auth hook and routes, Zernio mocked:
// every bot reads, only the operator and Polly (full access) reply, hide and
// delete, Polly's calls use her own key (or the agency key when she has
// none), and another client's account is not
// reachable at all. Also pins that Polly's full access is hers alone.
import assert from "node:assert/strict";

process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "sk_agency";
process.env.ZERNIO_API_KEY_POLLY = "sk_polly";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { commentRoutes } = await import("./comments");

const CLIENT = {
  id: "client1",
  agencyId: "agencyA",
  providerProfileId: "prof1",
  socialAccounts: [
    { id: "sa-ig", platform: "instagram", handle: "dudrents", providerAccountId: "z-ig" },
    { id: "sa-tt", platform: "tiktok", handle: "dudrents", providerAccountId: "z-tt" },
  ],
};
Object.defineProperty(getPrisma(), "client", {
  value: {
    findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
      where.id === CLIENT.id && where.agencyId === CLIENT.agencyId ? CLIENT : null,
  },
});

type Call = { url: string; method: string; auth: string; body: unknown };
const calls: Call[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({
    url,
    method: init?.method ?? "GET",
    auth: headers.Authorization ?? "",
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  const json = url.includes("/inbox/comments?")
    ? {
        data: [
          { id: "p1", platform: "instagram", accountId: "z-ig", content: "Track day in the M3", commentCount: 3 },
          { id: "p2", platform: "facebook", accountId: "z-fb", commentCount: 9 },
          { id: "p3", platform: "instagram", accountId: "z-someone-else", commentCount: 1 },
        ],
      }
    : url.includes("/inbox/comments/p1?")
      ? { comments: [{ id: "c1", message: "How much for a weekend?", from: { username: "miami.cars" }, canHide: true, canDelete: true }] }
      : { success: true, data: { commentId: "c9" } };
  return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const app = Fastify();
await app.register(jwt, { secret: "comments-check" });
await app.register(commentRoutes);

const operator = app.jwt.sign({ sub: "u1", agencyId: "agencyA" });
const bot = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot" });
const nova = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot", bot: "nova" });
const polly = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot", bot: "polly" });
const as = (t: string) => ({ authorization: `Bearer ${t}` });

// Reading: any bot. Only this client's Instagram/TikTok posts come back.
let res = await app.inject({ method: "GET", url: "/clients/client1/comments", headers: as(bot) });
assert.equal(res.statusCode, 200, res.body);
let body = res.json();
assert.deepEqual(body.posts.map((p: { id: string }) => p.id), ["p1"]);
assert.equal(body.canModerate, false);
assert.equal(calls.at(-1)!.auth, "Bearer sk_agency");

res = await app.inject({ method: "GET", url: "/clients/client1/comments/p1?accountId=z-ig", headers: as(nova) });
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().comments[0].username, "miami.cars");

// Another client's account is not reachable.
res = await app.inject({ method: "GET", url: "/clients/client1/comments/p3?accountId=z-someone-else", headers: as(operator) });
assert.equal(res.statusCode, 404);

// Writes: a plain or other named bot is refused, before Zernio is called.
const before = calls.length;
for (const t of [bot, nova]) {
  res = await app.inject({
    method: "POST",
    url: "/clients/client1/comments/p1/reply",
    headers: as(t),
    payload: { accountId: "z-ig", message: "$300", commentId: "c1" },
  });
  assert.equal(res.statusCode, 403, res.body);
  res = await app.inject({ method: "DELETE", url: "/clients/client1/comments/p1/c1?accountId=z-ig", headers: as(t) });
  assert.equal(res.statusCode, 403, res.body);
}
assert.equal(calls.length, before, "nothing reached Zernio");

// Polly: full access, on her own key.
res = await app.inject({ method: "GET", url: "/clients/client1/comments", headers: as(polly) });
assert.equal(res.json().canModerate, true);
assert.equal(calls.at(-1)!.auth, "Bearer sk_polly");
res = await app.inject({
  method: "POST",
  url: "/clients/client1/comments/p1/reply",
  headers: as(polly),
  payload: { accountId: "z-ig", message: "$300 for the weekend", commentId: "c1" },
});
assert.equal(res.statusCode, 200, res.body);
assert.equal(calls.at(-1)!.url, "https://zernio.com/api/v1/inbox/comments/p1");
assert.equal(calls.at(-1)!.auth, "Bearer sk_polly");
assert.deepEqual(calls.at(-1)!.body, { accountId: "z-ig", message: "$300 for the weekend", commentId: "c1" });

res = await app.inject({
  method: "POST",
  url: "/clients/client1/comments/p1/c1/hide",
  headers: as(polly),
  payload: { accountId: "z-ig", hidden: true },
});
assert.equal(res.statusCode, 200, res.body);
assert.equal(calls.at(-1)!.url, "https://zernio.com/api/v1/inbox/comments/p1/c1/hide");

// No separate key needed: with ZERNIO_API_KEY_POLLY unset Polly keeps full
// access and her calls go out on the agency key.
delete process.env.ZERNIO_API_KEY_POLLY;
res = await app.inject({ method: "GET", url: "/clients/client1/comments", headers: as(polly) });
assert.equal(res.json().canModerate, true);
assert.equal(calls.at(-1)!.auth, "Bearer sk_agency");
res = await app.inject({
  method: "POST",
  url: "/clients/client1/comments/p1/c1/hide",
  headers: as(polly),
  payload: { accountId: "z-ig", hidden: true },
});
assert.equal(res.statusCode, 200, res.body);
assert.equal(calls.at(-1)!.auth, "Bearer sk_agency");
process.env.ZERNIO_API_KEY_POLLY = "sk_polly";

// The operator deletes on the agency key.
res = await app.inject({ method: "DELETE", url: "/clients/client1/comments/p1/c1?accountId=z-ig", headers: as(operator) });
assert.equal(res.statusCode, 200, res.body);
assert.equal(calls.at(-1)!.method, "DELETE");
assert.equal(calls.at(-1)!.auth, "Bearer sk_agency");

// Instagram allowance for the composer counter.
res = await app.inject({ method: "GET", url: "/clients/client1/instagram-limit", headers: as(bot) });
assert.equal(res.statusCode, 200, res.body);
assert.equal(calls.at(-1)!.url, "https://zernio.com/api/v1/accounts/z-ig/instagram/publishing-limit");

await app.close();
console.log("comments.check: all checks passed");
