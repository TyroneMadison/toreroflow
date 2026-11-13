// Trello intake: the board and list are found by name and remembered, the
// card gets the brand's label (configured, else by color), a Trello failure
// is stored and retried, stale ids are re-discovered, the public form has a
// honeypot and a rate limit. Trello is mocked; nothing leaves the process.
import assert from "node:assert/strict";

process.env.TRELLO_KEY = "k";
process.env.TRELLO_TOKEN = "t";
delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { DEFAULT_TRELLO_INTAKE, cardText } = await import("./trelloIntake");
const { contentRequestRoutes, publicContentRequestRoutes, requestFormToken } = await import("../routes/contentRequests");
const { testApp, mockRateLimits } = await import("./testApp");

const BOARD = "b".repeat(24);
const LIST = "1".repeat(24);
const LABEL_RED = "e".repeat(24);
const LABEL_SET = "f".repeat(24);

// ---- Trello mock ----
const calls: { method: string; path: string; params: URLSearchParams }[] = [];
let failCards = 0;
let toEditName = "To Edit";
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  const path = u.pathname.replace(/^\/1/, "");
  calls.push({ method: init?.method ?? "GET", path, params: u.searchParams });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/members/me/boards") return json([{ id: "x".repeat(24), name: "Other" }, { id: BOARD, name: " torone editor pipeline " }]);
  if (path === `/boards/${BOARD}/lists`) return json([{ id: "2".repeat(24), name: "Ready for posting" }, { id: LIST, name: toEditName }]);
  if (path === `/boards/${BOARD}/labels`) return json([{ id: LABEL_RED, name: "Caleb", color: "red_dark" }]);
  if (path === "/cards") {
    if (failCards > 0) {
      failCards--;
      return json({}, 404);
    }
    return json({ id: "card1", shortUrl: "https://trello.com/c/abc" });
  }
  return json({}, 500);
}) as typeof fetch;

// ---- in-memory database ----
const settings = new Map<string, unknown>();
const requests: Record<string, unknown>[] = [];
const clients = [
  { id: "caleb", agencyId: "A", name: "Caleb Rentals", slug: "caleb", trelloLabels: [], deletedAt: null },
  { id: "dud", agencyId: "A", name: "Dudley", slug: null, trelloLabels: [], deletedAt: null },
];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
type Key = { where: { agencyId_key: { agencyId: string; key: string } } };
const sk = (w: Key["where"]) => `${w.agencyId_key.agencyId}|${w.agencyId_key.key}`;
mock("appSetting", {
  findUnique: async ({ where }: Key) => (settings.has(sk(where)) ? { value: settings.get(sk(where)) } : null),
  upsert: async ({ where, create }: Key & { create: { value: unknown } }) => void settings.set(sk(where), create.value),
});
mock("client", {
  findFirst: async ({ where }: { where: { id: string } }) => clients.find((c) => c.id === where.id) ?? null,
  findMany: async ({ where }: { where: { agencyId: string } }) => clients.filter((c) => c.agencyId === where.agencyId),
});
await mockRateLimits();
// One live form link per brand; the request form is only reachable through one.
const links = clients.map((c) => ({ id: `link-${c.id}`, clientId: c.id, revokedAt: null, client: { name: c.name, deletedAt: null } }));
mock("requestFormLink", { findUnique: async ({ where }: { where: { id: string } }) => links.find((l) => l.id === where.id) ?? null });
mock("requestFormAudit", { create: async () => ({}) });
const withClient = (r: Record<string, unknown>) => ({ ...r, client: clients.find((c) => c.id === r.clientId)! });
mock("contentRequest", {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    const r = { id: `r${requests.length + 1}`, status: "pending", ...data };
    requests.push(r);
    return r;
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    const r = requests.find((x) => x.id === where.id);
    return r ? withClient(r) : null;
  },
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    requests.find((x) => x.id === where.id && withClient(x).client.agencyId === where.client.agencyId) ?? null,
  findMany: async ({ where }: { where: { client: { agencyId: string }; clientId?: string } }) =>
    requests.filter((x) => withClient(x).client.agencyId === where.client.agencyId && (!where.clientId || x.clientId === where.clientId)),
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(requests.find((x) => x.id === where.id)!, data),
});

assert.deepEqual(cardText({ what: "Walkaround of the M3\nwith sound", dueDate: "2026-11-05", footageUrl: null, notes: "low angle" }), {
  name: "Walkaround of the M3",
  desc: "Walkaround of the M3\nwith sound\n\nDue: 2026-11-05\n\nNotes: low angle\n\nFrom the client request form.",
});

const pub = await testApp(publicContentRequestRoutes);
const ops = await testApp(contentRequestRoutes);
const post = ({ brandId, ...payload }: { brandId: string } & Record<string, unknown>, remoteAddress = "9.9.9.9") =>
  pub.app.inject({ method: "POST", url: `/r/${requestFormToken(`link-${brandId}`)}`, payload, remoteAddress });
const submit = (payload: { brandId: string } & Record<string, unknown>) => post(payload);

// A request: board and list found by name (case and spacing ignored), ids kept,
// card made on "To edit" with the red label (Caleb's default color).
let res = await submit({ brandId: "caleb", what: "Walkaround of the M3", dueDate: "2026-11-05", footageUrl: "https://drive.google.com/x" });
assert.equal(res.statusCode, 201, res.body);
assert.deepEqual(res.json(), { ok: true });
let card = calls.find((c) => c.path === "/cards")!;
assert.equal(card.method, "POST");
assert.equal(card.params.get("idList"), LIST);
assert.equal(card.params.get("idLabels"), LABEL_RED);
assert.equal(card.params.get("due"), "2026-11-05T17:00:00.000Z");
assert.equal(requests[0]!.status, "created");
assert.equal(requests[0]!.trelloUrl, "https://trello.com/c/abc");
assert.deepEqual(settings.get("A|trello_intake"), { ...DEFAULT_TRELLO_INTAKE, boardId: BOARD, listId: LIST });

// The next one reuses the stored ids: no board lookup.
calls.length = 0;
res = await submit({ brandId: "dud", what: "Two reels from the shoot" });
assert.equal(res.statusCode, 201);
assert.equal(calls.some((c) => c.path === "/members/me/boards"), false);
card = calls.find((c) => c.path === "/cards")!;
assert.equal(card.params.get("idLabels"), null, "Dudley's black label is not on the board: the card is made unlabeled");

// A configured label wins over the color.
settings.set("A|trello_intake", { ...DEFAULT_TRELLO_INTAKE, boardId: BOARD, listId: LIST, labelByBrand: { dud: LABEL_SET } });
calls.length = 0;
await submit({ brandId: "dud", what: "Thumbnail set" });
assert.equal(calls.find((c) => c.path === "/cards")!.params.get("idLabels"), LABEL_SET);
assert.equal(calls.some((c) => c.path.endsWith("/labels")), false);

// Trello fails (the list moved): stored as failed, ids forgotten, Retry finds them again.
failCards = 1;
toEditName = "to edit";
res = await submit({ brandId: "caleb", what: "Price drop reel" });
assert.equal(res.statusCode, 201, "the client is never shown a Trello error");
const failed = requests.at(-1)!;
assert.equal(failed.status, "failed");
assert.match(String(failed.error), /Trello 404/);
assert.equal((settings.get("A|trello_intake") as { listId: string | null }).listId, null);

res = await ops.app.inject({ method: "POST", url: `/requests/${failed.id}/retry`, headers: ops.nova });
assert.equal(res.statusCode, 403, "other bots cannot retry");
res = await ops.app.inject({ method: "POST", url: `/requests/${failed.id}/retry`, headers: ops.polly });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { status: "created", error: null });
assert.equal((settings.get("A|trello_intake") as { listId: string }).listId, LIST);
res = await ops.app.inject({ method: "POST", url: `/requests/${failed.id}/retry`, headers: ops.otherAgency });
assert.equal(res.statusCode, 404);

// Operator list.
res = await ops.app.inject({ method: "GET", url: "/requests?brandId=caleb", headers: ops.operator });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.json().requests.map((r: { status: string }) => r.status), ["created", "created"]);

// Validation, unknown brand, honeypot, rate limit.
const count = requests.length;
res = await post({ brandId: "caleb", what: "  " }, "1.1.1.1");
assert.equal(res.statusCode, 400);
res = await post({ brandId: "nobody", what: "x" }, "1.1.1.1");
assert.equal(res.statusCode, 404);
res = await post({ brandId: "caleb", what: "buy pills", website: "spam.biz" }, "2.2.2.2");
assert.equal(res.statusCode, 201);
assert.equal(requests.length, count, "honeypot submissions are dropped");
assert.equal((await submit({ brandId: "caleb", what: "fifth" })).statusCode, 201);
res = await submit({ brandId: "caleb", what: "one too many" });
assert.equal(res.statusCode, 429, "the sixth request from one IP in 10 minutes");

// Intake config: readable, label ids validated, other bots cannot change it.
res = await ops.app.inject({ method: "GET", url: "/trello/intake-config", headers: ops.operator });
assert.equal(res.json().listName, "To edit");
const body = { ...DEFAULT_TRELLO_INTAKE, labelByBrand: { caleb: LABEL_SET } };
res = await ops.app.inject({ method: "PUT", url: "/trello/intake-config", headers: ops.nova, payload: body });
assert.equal(res.statusCode, 403);
res = await ops.app.inject({ method: "PUT", url: "/trello/intake-config", headers: ops.operator, payload: { ...body, labelByBrand: { caleb: "red" } } });
assert.equal(res.statusCode, 400);
res = await ops.app.inject({ method: "PUT", url: "/trello/intake-config", headers: ops.polly, payload: body });
assert.equal(res.statusCode, 200, res.body);
assert.equal((settings.get("A|trello_intake") as { labelByBrand: Record<string, string> }).labelByBrand.caleb, LABEL_SET);

await pub.app.close();
await ops.app.close();
console.log("trelloIntake.check: ok");
