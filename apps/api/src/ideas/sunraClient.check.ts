// The Sunra REST client on a mocked fetch: catalog join and USD-to-credit pricing,
// submit/poll/result/download per slide, typed failures, the deadline cancels,
// and the key only ever goes to Sunra in the Authorization header.
import assert from "node:assert/strict";
import { SunraError, sunraClient, usdPerImage } from "./sunraClient";

const KEY = "sk-test-secret";
type Call = { method: string; url: string; auth: string | null; body: any };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | Promise<Response>> = {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const c: Call = {
    method: init.method ?? "GET",
    url,
    auth: new Headers(init.headers).get("authorization"),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(c);
  const route = routes[`${c.method} ${url}`];
  if (!route) throw new Error(`unexpected ${c.method} ${url}`);
  return route(c);
}) as typeof fetch;

const B = "https://sunra.test";
const opts = { apiKey: KEY, base: `${B}/`, pollMs: 1, maxPollMs: 4, timeoutMs: 1000 };

// ---- Catalog ----
routes = {
  [`GET ${B}/v1/models?limit=300`]: () =>
    json({
      object: "list",
      data: [
        { id: "model_flux", alias: "black-forest-labs/flux-1.1-pro" },
        { id: "model_seed", alias: "bytedance/seedream-5.0-pro" },
        { id: "model_kling", alias: "kling/kling-v3-4k" },
      ],
    }),
  [`GET ${B}/v1/pricing?limit=10000`]: () =>
    json({
      object: "list",
      has_more: false,
      data: [
        { id: "mep_1", model_name: "flux-1.1-pro", model_endpoint: "text-to-image" },
        { id: "mep_2", model_name: "seedream-5.0-pro", model_endpoint: "image-editing" },
        { id: "mep_3", model_name: "kling-v3-4k", model_endpoint: "text-to-video" },
      ],
    }),
  [`GET ${B}/v1/pricing/model/model_flux/endpoint/text-to-image`]: () =>
    json({ object: "model_endpoint_price", type: "pre_defined", prices: [{ unit_amount: "0.07", matches: { resolution: "1K" } }, { unit_amount: "0.045" }] }),
};
const { catalog, generator } = sunraClient(opts);
const models = await catalog.listModels();
assert.deepEqual(models, [
  {
    kind: "image",
    id: "black-forest-labs/flux-1.1-pro",
    label: "flux-1.1-pro",
    provider: "black-forest-labs",
    supportedAspectRatios: [],
    supportedSizes: [],
    supportedResolutions: [],
    maxRefImages: 0,
  },
]);
assert.equal(await catalog.estimateCost("black-forest-labs/flux-1.1-pro"), 7, "dearest row, $0.07 is 7 credits exactly");
assert.ok(calls.every((c) => c.auth === `Key ${KEY}`), "Authorization: Key <key> on every Sunra call");
await assert.rejects(catalog.estimateCost("nope/model"), SunraError);

// Price cards: usage-settled ones reserve freeze_amount; no price is an error.
assert.equal(usdPerImage({ type: "post_calculated", freeze_amount: 0.2, prices: [{ unit_amount: "0.03" }] }), 0.2);
assert.equal(usdPerImage({ type: "pre_defined", prices: [{ unit_amount: "0.045" }, { unit_amount: "0.126" }] }), 0.126);
assert.throws(() => usdPerImage({ prices: [] }), SunraError);

// A Sunra error answer is typed, keeps Sunra's code, and never echoes the key.
routes[`GET ${B}/v1/models?limit=300`] = () =>
  json({ error: { type: "authentication_error", code: "api_key_invalid", message: "The key does not match" } }, 401);
const err = await catalog.listModels().then(() => null, (e) => e);
assert.ok(err instanceof SunraError);
assert.deepEqual([err.status, err.code], [401, "api_key_invalid"]);
assert.ok(!err.message.includes(KEY));

// ---- Generator: one queued request per slide, polled, fetched, downloaded ----
calls = [];
let n = 0;
const statuses: Record<string, string[]> = {};
routes = {
  [`POST ${B}/v1/queue/black-forest-labs/flux-1.1-pro/text-to-image`]: () => {
    const id = `pd_${++n}`;
    statuses[id] = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
    return json({ request_id: id });
  },
};
for (const id of ["pd_1", "pd_2"]) {
  routes[`GET ${B}/v1/queue/requests/${id}/status`] = () => {
    const status = statuses[id]!.shift()!;
    return json({ status, ...(status === "COMPLETED" ? { success: true, error: null } : {}) });
  };
  routes[`GET ${B}/v1/queue/requests/${id}`] = () => json({ images: [{ url: `https://cdn.test/${id}.png` }] });
  routes[`GET https://cdn.test/${id}.png`] = () => new Response(`png ${id}`);
}
const job = { prompt: "Fall lineup", slides: 2, platform: "tiktok" as const, modelId: "black-forest-labs/flux-1.1-pro", width: 1080, height: 1920, aspectRatio: "9:16" };
const images = await generator(job);
assert.deepEqual(images.map(String), ["png pd_1", "png pd_2"]);
const submits = calls.filter((c) => c.method === "POST");
assert.deepEqual(
  submits.map((c) => c.body),
  [
    { prompt: "Fall lineup\n\nSlide 1 of 2.", aspect_ratio: "9:16" },
    { prompt: "Fall lineup\n\nSlide 2 of 2.", aspect_ratio: "9:16" },
  ],
);
assert.equal(calls.filter((c) => c.url.endsWith("pd_1/status")).length, 3, "polled until COMPLETED");
assert.equal(calls.find((c) => c.url.startsWith("https://cdn.test"))!.auth, null, "the key never goes to the image host");

// Rate-limited polls are retried, not fatal.
n = 0;
calls = [];
let limited = 1;
routes[`GET ${B}/v1/queue/requests/pd_1/status`] = () => (limited-- > 0 ? json({}, 429) : json({ status: "COMPLETED", success: true, error: null }));
assert.deepEqual((await generator({ ...job, slides: 1 })).map(String), ["png pd_1"]);
assert.deepEqual(calls[0]!.body, { prompt: "Fall lineup", aspect_ratio: "9:16" }, "one slide keeps the prompt as typed");

// A failed prediction stops the carousel at that slide with Sunra's failure code.
n = 0;
calls = [];
routes[`GET ${B}/v1/queue/requests/pd_1/status`] = () =>
  json({ status: "COMPLETED", success: false, error: { code: "unsafe_content", reason: "moderation_blocked", retryable: false, message: "suppressed" } });
const failed = await generator(job).then(() => null, (e) => e);
assert.ok(failed instanceof SunraError);
assert.deepEqual([failed.code, failed.retryable, failed.message], ["unsafe_content", false, "Sunra could not make the image: suppressed"]);
assert.equal(calls.filter((c) => c.method === "POST").length, 1, "slide 2 never submitted");

// Our own deadline cancels the request and fails.
n = 0;
calls = [];
routes[`GET ${B}/v1/queue/requests/pd_1/status`] = () => json({ status: "IN_PROGRESS" });
routes[`PUT ${B}/v1/queue/requests/pd_1/cancel`] = () => json({});
const slow = sunraClient({ ...opts, slideDeadlineMs: 30 });
const timedOut = await slow.generator({ ...job, slides: 1 }).then(() => null, (e) => e);
assert.ok(timedOut instanceof SunraError);
assert.match(timedOut.message, /did not finish pd_1 within 30 ms; cancelled/);
assert.ok(calls.some((c) => c.method === "PUT" && c.url.endsWith("/pd_1/cancel")));

// An HTTP call that hangs is cut off by the per-call timeout.
routes[`POST ${B}/v1/queue/black-forest-labs/flux-1.1-pro/text-to-image`] = () => new Promise<Response>(() => {});
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) =>
  new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout's timer does not hold the process open
const hung = await sunraClient({ ...opts, timeoutMs: 20 })
  .generator({ ...job, slides: 1 })
  .then(() => null, (e) => e);
clearInterval(keepAlive);
assert.ok(hung instanceof SunraError);
assert.match(hung.message, /timed out after 20 ms/);

console.log("sunraClient.check: ok");
