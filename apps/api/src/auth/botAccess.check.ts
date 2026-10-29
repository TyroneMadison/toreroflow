// The whitelist is the entire security boundary between an automation and the
// agency's books, media library and client DMs. Both directions are pinned:
// everything the workflow needs passes, and the dangerous neighbors of each
// allowed route are named and refused.
import assert from "node:assert/strict";
import { getPrisma } from "@toreroflow/db";
import { botAllowed, defaultBotIdentity, resolveBotIdentity } from "./botAccess";

// The whole upload -> draft -> schedule workflow passes.
for (const [method, path] of [
  ["GET", "/auth/me"],
  ["GET", "/clients"],
  ["POST", "/clients/cms0qdz5t/media"],
  ["GET", "/clients/cms0qdz5t/media"],
  ["GET", "/media/cms84z50v"],
  ["PATCH", "/media/cms84z50v/draft"],
  ["PATCH", "/media/cms84z50v/format"],
  ["POST", "/media/cms84z50v/schedule"],
  ["PATCH", "/media/cms84z50v/cover"],
  ["POST", "/media/cms84z50v/cover-image"],
  ["GET", "/media/cms84z50v/instagram-fit?accountId=a1"],
  ["GET", "/clients/cms0qdz5t/posts"],
  ["GET", "/clients/cms0qdz5t/posts?from=2026-09-01"],
  ["GET", "/trello/ready"],
  ["GET", "/clients/label-map"],
  ["GET", "/clients/cms0qdz5t/sop"],
  // Comments: reading is open to every bot.
  ["GET", "/clients/cms0qdz5t/comments"],
  ["GET", "/clients/cms0qdz5t/comments/p1?accountId=a1"],
  ["GET", "/clients/cms0qdz5t/instagram-limit"],
  // Templates: the route checks the scope.
  ["GET", "/templates"],
  ["GET", "/templates?brandId=c1"],
  ["GET", "/templates/cadence?brandId=c1"],
  ["POST", "/templates/tpl1/apply"],
] as const) {
  assert.equal(botAllowed(method, path), true, `${method} ${path} is the workflow`);
}

// The dangerous neighbors of each allowed route are refused.
for (const [method, path] of [
  // Caption block and keyword lines are human-only settings.
  ["PUT", "/clients/cms0qdz5t/caption-block"],
  // Same paths, wrong verbs.
  ["DELETE", "/media/cms84z50v"],
  ["DELETE", "/posts/targets/cms84z50v"],
  ["POST", "/clients"],
  ["DELETE", "/clients/cms0qdz5t"],
  ["PATCH", "/posts/targets/cms84z50v/reschedule"],
  ["POST", "/posts/targets/cms84z50v/retry"],
  // Money, messages, credentials.
  ["GET", "/financials/summary"],
  ["GET", "/clients/cms0qdz5t/inbox"],
  ["POST", "/clients/cms0qdz5t/dm-campaigns"],
  ["POST", "/auth/bot-token"],
  ["POST", "/auth/login"],
  // Trello writes beyond the one card move.
  ["PUT", "/trello/cards/6a7b3cc5916d5e9d219af197"],
  ["DELETE", "/trello/cards/6a7b3cc5916d5e9d219af197"],
  ["PUT", "/clients/cms0qdz5t/trello-labels"],
  ["PUT", "/clients/cms0qdz5t/sop"],
  ["POST", "/trello/cards"],
  ["POST", "/trello/cards/6a7b3cc5916d5e9d219af197/attachments"],
  ["POST", "/trello/cards/6a7b3cc5916d5e9d219af197/attachments/link"],
  ["GET", "/oauth/connections"],
  ["POST", "/accounts/acc1/facebook-reconnect"],
  // Nested lookalikes a sloppy regex would wave through.
  ["POST", "/clients/cms0qdz5t/media/../../financials"],
  ["GET", "/media/cms84z50v/transcript"],
  ["POST", "/media/cms84z50v/cover-image/../../financials"],
  ["DELETE", "/media/cms84z50v/cover"],
  // Templates: no bot edits them without full access.
  ["POST", "/templates"],
  ["PUT", "/templates/tpl1"],
  ["DELETE", "/templates/tpl1"],
] as const) {
  assert.equal(botAllowed(method, path), false, `${method} ${path} must be refused`);
}

// The query string never changes the verdict.
assert.equal(botAllowed("GET", "/financials/summary?x=1"), false, "query cannot smuggle");
// Moderating comments is not on the whitelist; only a full-access bot gets it.
assert.equal(botAllowed("POST", "/clients/c1/comments/p1/reply"), false, "reply needs the operator");
assert.equal(botAllowed("DELETE", "/clients/c1/comments/p1/c1"), false, "delete needs the operator");
assert.equal(botAllowed("POST", "/clients/c1/comments/p1/c1/hide"), false, "hide needs the operator");
assert.equal(botAllowed("PUT", "/clients/cms0qdz5t/sop"), false, "editing an SOP stays human");
assert.equal(botAllowed("PUT", "/clients/cms0qdz5t/trello-labels"), false, "label routing stays human");

// Full access comes from the BotIdentity flag. With no row, Polly defaults to
// the contracts POLLY (full access) and every other bot to none.
assert.equal(defaultBotIdentity("polly").fullAccess, true);
assert.equal(defaultBotIdentity("Polly").fullAccess, true);
assert.equal(defaultBotIdentity("nova").fullAccess, false);
assert.deepEqual(defaultBotIdentity("nova").scopes, []);
assert.equal(defaultBotIdentity(undefined).fullAccess, false);

const rows: Record<string, { fullAccess: boolean; scopes: string[] }> = {
  "agencyA/nova": { fullAccess: false, scopes: ["templates:read", "bogus"] },
  "agencyB/polly": { fullAccess: false, scopes: [] },
};
let dbDown = false;

// Phase 8: clip-job routes for bots, destructive ones stay closed.
assert.equal(botAllowed("POST", "/clients/c1/clip-jobs"), true, "bot starts a clip job");
assert.equal(botAllowed("POST", "/clients/c1/clip-jobs/from-drive"), true, "bot starts from Drive");
assert.equal(botAllowed("GET", "/clip-jobs/j1?q=money"), true, "bot reads a job");
assert.equal(botAllowed("POST", "/clip-candidates/batch-render"), true, "bot batch-renders");
assert.equal(botAllowed("DELETE", "/clip-jobs/j1"), false, "bot cannot delete a job");
assert.equal(botAllowed("POST", "/clip-jobs/j1/refine"), false, "refine (AI spend) stays operator-only");
assert.equal(botAllowed("PUT", "/clients/c1/auto-import"), false, "auto-import settings stay operator-only");
Object.defineProperty(getPrisma(), "botIdentity", {
  value: {
    findUnique: async ({ where }: { where: { agencyId_name: { agencyId: string; name: string } } }) => {
      if (dbDown) throw new Error("relation BotIdentity does not exist");
      const k = where.agencyId_name;
      return rows[`${k.agencyId}/${k.name}`] ?? null;
    },
  },
});
// No row: defaults.
assert.equal((await resolveBotIdentity("agencyA", "polly")).fullAccess, true);
assert.equal((await resolveBotIdentity("agencyA", "deploy")).fullAccess, false);
// A row decides, and unknown scopes are dropped.
assert.deepEqual(await resolveBotIdentity("agencyA", "Nova"), { name: "nova", fullAccess: false, scopes: ["templates:read"] });
assert.equal((await resolveBotIdentity("agencyB", "polly")).fullAccess, false, "the flag can switch Polly off");
// Table missing (migration not deployed): defaults, never a 500.
dbDown = true;
assert.equal((await resolveBotIdentity("agencyA", "polly")).fullAccess, true);
assert.equal((await resolveBotIdentity("agencyA", "nova")).fullAccess, false);
dbDown = false;

// Through the real hook: Polly reaches an operator-only route, other bots
// keep the whitelist exactly.
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { requireAuth } = await import("../plugins/requireAuth");
const app = Fastify();
await app.register(jwt, { secret: "bot-access-check" });
app.addHook("onRequest", requireAuth);
app.get("/financials/summary", async () => ({ ok: true }));
app.get("/clients", async () => ({ ok: true }));
const call = (url: string, bot?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${app.jwt.sign({ sub: "s", agencyId: "agencyA", role: "bot", ...(bot ? { bot } : {}) })}` },
  });
assert.equal((await call("/financials/summary", "polly")).statusCode, 200, "Polly has full access");
assert.equal((await call("/financials/summary", "nova")).statusCode, 403, "nova keeps the whitelist");
assert.equal((await call("/financials/summary")).statusCode, 403, "an unnamed bot keeps the whitelist");
assert.equal((await call("/clients", "nova")).statusCode, 200, "nova still reads the whitelist");
await app.close();

console.log("botAccess.check: all checks passed");
