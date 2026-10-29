// Failed posts: errors mapped to a plain reason and to Retry or Reconnect,
// retry is manual and never duplicates a post that is already live (checked
// with the provider first, and refused when the provider cannot say).
// Zernio is mocked and the queue is a stand-in; nothing leaves the process.
import assert from "node:assert/strict";

process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "sk_test";
delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { FailedPostListSchema, FailedPostRetryResultSchema, FailedPostDismissResultSchema } = await import("@toreroflow/contracts");
const { failedPostRoutes, retryAction } = await import("../routes/failedPosts");
const { publishQueue } = await import("../posts/requeue");
const { testApp } = await import("./testApp");

// ---- error mapping ----
assert.equal(retryAction("Instagram access token has expired", "connected"), "reconnect");
assert.equal(retryAction("Unauthorized: reconnect the account", "connected"), "reconnect");
assert.equal(retryAction("Publishing failed due to max retries reached", "connected"), "retry");
assert.equal(retryAction("rate limit hit", "connected"), "retry");
assert.equal(retryAction(null, "needs_reconnect"), "reconnect", "a disconnected account always needs Reconnect");

// ---- fixtures ----
const queued: string[] = [];
publishQueue.reschedule = (async (_q: string, _data: object, key: string) => void queued.push(key)) as typeof publishQueue.reschedule;

const base = { postId: "p1", options: { queueDismissedAt: "x", keep: 1 }, scheduledAt: new Date("2026-10-20T15:00:00Z"), publishedAt: null, remoteUrl: null };
const targets: Record<string, any>[] = [
  { ...base, id: "t-ig", platform: "instagram", status: "failed", error: "Publishing failed due to max retries reached", remotePostId: "late-ig", socialAccount: { status: "connected", providerAccountId: "z-ig" } },
  { ...base, id: "t-tt", platform: "tiktok", status: "failed", error: "TikTok access token expired", remotePostId: null, socialAccount: { status: "connected", providerAccountId: "z-tt" } },
  { ...base, id: "t-yt", platform: "youtube", status: "failed", error: "rate limit", remotePostId: "late-yt", socialAccount: { status: "connected", providerAccountId: "z-yt" } },
  { ...base, id: "t-fb", platform: "facebook", status: "failed", error: "x", remotePostId: null, socialAccount: { status: "connected", providerAccountId: null } },
  { ...base, id: "t-pub", platform: "instagram", status: "publishing", error: null, remotePostId: "late-p", socialAccount: { status: "connected", providerAccountId: "z-ig" } },
  { ...base, id: "t-new", platform: "instagram", status: "failed", error: "Something odd", remotePostId: null, socialAccount: { status: "connected", providerAccountId: "z-ig" } },
];
const posts = new Map<string, string>();
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("postTarget", {
  findMany: async ({ where }: { where: { status: string; platform: { in: string[] }; post: { client: { agencyId: string } } } }) =>
    where.post.client.agencyId !== "A"
      ? []
      : targets
          .filter((t) => t.status === where.status && !t.failureDismissedAt && where.platform.in.includes(t.platform))
          .map((t) => ({ ...t, post: { clientId: t.clientId ?? "caleb" } })),
  findFirst: async ({ where }: { where: { id: string; post: { client: { agencyId: string } } } }) =>
    where.post.client.agencyId === "A" ? targets.find((t) => t.id === where.id) ?? null : null,
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(targets.find((t) => t.id === where.id)!, data),
  updateMany: async ({ where, data }: { where: { id?: { in: string[] }; status: string; failureDismissedAt: null; platform: { in: string[] }; post: { clientId?: string; client: { agencyId: string } } }; data: object }) => {
    if (where.post.client.agencyId !== "A") return { count: 0 };
    const hit = targets.filter(
      (t) =>
        (!where.id || where.id.in.includes(t.id)) &&
        t.status === where.status &&
        where.platform.in.includes(t.platform) &&
        !t.failureDismissedAt &&
        (!where.post.clientId || (t.clientId ?? "caleb") === where.post.clientId),
    );
    hit.forEach((t) => Object.assign(t, data));
    return { count: hit.length };
  },
});
mock("post", { update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => void posts.set(where.id, data.status) });

let zernioDown = false;
const zernioCalls: string[] = [];
globalThis.fetch = (async (url: string) => {
  zernioCalls.push(url);
  if (zernioDown) return new Response("{}", { status: 500 });
  const live = url.endsWith("/posts/late-ig");
  return new Response(
    JSON.stringify({
      post: {
        status: live ? "partial" : "failed",
        platforms: [
          { platform: "instagram", accountId: "z-ig", status: live ? "published" : "failed", platformPostUrl: "https://instagram.com/reel/live" },
          { platform: "youtube", accountId: "z-yt", status: "failed" },
        ],
      },
    }),
    { status: 200 },
  );
}) as typeof fetch;

const { app, operator, polly, nova, otherAgency } = await testApp(failedPostRoutes);
const retry = (id: string, headers = operator) => app.inject({ method: "POST", url: `/failed-posts/${id}/retry`, headers });

// The list: failed targets on the three platforms, reason and action.
let res = await app.inject({ method: "GET", url: "/failed-posts", headers: polly });
assert.equal(res.statusCode, 200, res.body);
const list = FailedPostListSchema.parse(res.json());
assert.equal(list.count, 4);
assert.deepEqual(list.items.map((i) => i.postTargetId), ["t-ig", "t-tt", "t-yt", "t-new"]);
assert.equal(list.items.find((i) => i.postTargetId === "t-tt")!.action, "reconnect");
assert.equal(list.items.find((i) => i.postTargetId === "t-ig")!.action, "retry");
assert.ok(list.items.every((i) => i.reason.length > 0));
res = await app.inject({ method: "GET", url: "/failed-posts", headers: otherAgency });
assert.equal(res.json().count, 0);
res = await app.inject({ method: "GET", url: "/failed-posts", headers: nova });
assert.equal(res.statusCode, 403);

// Retry of a post the provider says went live: marked posted, never re-queued.
res = await retry("t-ig");
assert.deepEqual(FailedPostRetryResultSchema.parse(res.json()), { outcome: "already_live" });
assert.equal(targets[0]!.status, "posted");
assert.equal(targets[0]!.remoteUrl, "https://instagram.com/reel/live");
assert.deepEqual(queued, []);
res = await retry("t-ig");
assert.deepEqual(res.json(), { outcome: "already_live" }, "a second press is still a no-op");
assert.deepEqual(queued, []);

// Expired token: Reconnect, nothing queued.
res = await retry("t-tt");
assert.deepEqual(res.json(), { outcome: "needs_reconnect" });
assert.equal(targets[1]!.status, "failed");
assert.deepEqual(queued, []);

// The provider cannot be reached: refused, not guessed.
zernioDown = true;
res = await retry("t-yt");
assert.equal(res.statusCode, 503);
assert.deepEqual(queued, []);
zernioDown = false;

// Really failed: re-queued now, error and dismissal cleared, post back to scheduled.
res = await retry("t-yt", polly);
assert.deepEqual(res.json(), { outcome: "queued" });
assert.deepEqual(queued, ["t-yt"]);
assert.equal(targets[2]!.status, "scheduled");
assert.equal(targets[2]!.error, null);
assert.deepEqual(targets[2]!.options, { keep: 1 });
assert.equal(posts.get("p1"), "scheduled");

// No remote post yet: nothing to check, queued.
const calls = zernioCalls.length;
res = await retry("t-new");
assert.deepEqual(res.json(), { outcome: "queued" });
assert.equal(zernioCalls.length, calls);

// Retried target is no longer failed; in-flight targets are never re-queued.
res = await retry("t-yt");
assert.equal(res.statusCode, 409);
res = await retry("t-pub");
assert.equal(res.statusCode, 409);
assert.deepEqual(queued, ["t-yt", "t-new"]);

res = await retry("t-yt", nova);
assert.equal(res.statusCode, 403);
res = await retry("t-yt", otherAgency);
assert.equal(res.statusCode, 404);

// ---- dismiss: hides the notice, never touches the post ----
targets.push(
  { ...base, id: "t-d1", platform: "instagram", status: "failed", error: "x", remotePostId: null, socialAccount: { status: "connected", providerAccountId: "z-ig" } },
  { ...base, id: "t-d2", platform: "instagram", status: "failed", error: "x", remotePostId: null, socialAccount: { status: "connected", providerAccountId: "z-ig" } },
  { ...base, id: "t-d3", platform: "tiktok", status: "failed", error: "x", remotePostId: null, clientId: "brand2", socialAccount: { status: "connected", providerAccountId: "z-tt" } },
);
const listIds = async () => (await app.inject({ method: "GET", url: "/failed-posts", headers: operator })).json().items.map((i: { postTargetId: string }) => i.postTargetId);
const dismissOne = (id: string, headers = operator) => app.inject({ method: "POST", url: `/failed-posts/${id}/dismiss`, headers });
const dismissMany = (payload: object, headers = operator) => app.inject({ method: "POST", url: "/failed-posts/dismiss", headers, payload });
assert.deepEqual(await listIds(), ["t-tt", "t-d1", "t-d2", "t-d3"]);
const postsBefore = new Map(posts);

res = await dismissOne("t-d1", nova);
assert.equal(res.statusCode, 403);
res = await dismissOne("t-d1");
assert.deepEqual(FailedPostDismissResultSchema.parse(res.json()), { dismissed: 1 });
assert.deepEqual(await listIds(), ["t-tt", "t-d2", "t-d3"], "dismissed leaves the list and the count");
assert.equal(targets.find((t) => t.id === "t-d1")!.status, "failed", "the post itself stays failed and retryable");
assert.equal((await dismissOne("t-d1")).statusCode, 404, "already dismissed");
assert.equal((await dismissOne("t-ig")).statusCode, 404, "a published post is never touched");
assert.equal(targets[0]!.failureDismissedAt, undefined);
assert.equal((await dismissOne("t-tt", otherAgency)).statusCode, 404);

// Bulk: selected ones; a published id in the set is skipped.
res = await dismissMany({ postTargetIds: ["t-d2", "t-ig"] });
assert.deepEqual(res.json(), { dismissed: 1 });
assert.equal((await dismissMany({})).statusCode, 400);
assert.equal((await dismissMany({ all: true, postTargetIds: ["t-tt"] })).statusCode, 400);
assert.equal((await dismissMany({ all: true }, nova)).statusCode, 403);
// All, for one brand, then all.
res = await dismissMany({ all: true, brandId: "brand2" });
assert.deepEqual(res.json(), { dismissed: 1 });
assert.deepEqual(await listIds(), ["t-tt"]);
res = await dismissMany({ all: true });
assert.deepEqual(res.json(), { dismissed: 1 });
res = await app.inject({ method: "GET", url: "/failed-posts", headers: operator });
assert.equal(res.json().count, 0);
assert.deepEqual(posts, postsBefore, "no post was changed by a dismiss");
assert.equal(targets[0]!.status, "posted");

// A retry clears the dismissal, so a second failure shows again.
res = await retry("t-d1");
assert.deepEqual(res.json(), { outcome: "queued" });
assert.equal(targets.find((t) => t.id === "t-d1")!.failureDismissedAt, null);

await app.close();
console.log("failedPosts.check: ok");
