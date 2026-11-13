// Repurpose stub: the step state machine (resumable, failed steps retry in
// place, review then done) and the routes. No provider exists to call.
import assert from "node:assert/strict";

delete process.env.BOT_FULL_ACCESS;
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;
const { getPrisma } = await import("@toreroflow/db");
const { RepurposeJobSchema } = await import("@toreroflow/contracts");
const { advance, repurposeRoutes, STEPS } = await import("../routes/repurpose");
const { testApp } = await import("./testApp");

// ---- the state machine, walked end to end with a stand-in runner ----
let job: { step: (typeof STEPS)[number]; state: "queued" | "running" | "failed" | "done" } = { step: "transcribe", state: "queued" };
const seen: string[] = [];
let failedOnce = false;
while (job.state !== "done") {
  job = advance(job, "start")!;
  seen.push(job.step);
  if (job.step === "cut" && !failedOnce) {
    failedOnce = true;
    job = advance(job, "fail")!;
    assert.deepEqual(job, { step: "cut", state: "failed" });
    job = advance(job, "retry")!;
    assert.deepEqual(job, { step: "cut", state: "queued" }, "retry resumes at the failed step");
    continue;
  }
  job = advance(job, "succeed")!;
}
assert.deepEqual(seen, ["transcribe", "find_moments", "cut", "cut", "captions", "thumbnails", "review"]);
assert.deepEqual(job, { step: "done", state: "done" });

assert.equal(advance({ step: "cut", state: "queued" }, "succeed"), null, "a step must run before it succeeds");
assert.equal(advance({ step: "cut", state: "queued" }, "retry"), null);
assert.equal(advance({ step: "cut", state: "running" }, "start"), null);
assert.equal(advance({ step: "done", state: "done" }, "start"), null);

// ---- routes ----
const jobs: Record<string, any>[] = [];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; kind: string; client: { agencyId: string } } }) =>
    where.id === "long1" && where.kind === "video" && where.client.agencyId === "A" ? { id: "long1", clientId: "caleb" } : null,
});
mock("repurposeJob", {
  create: async ({ data }: { data: object }) => {
    const j = { id: `j${jobs.length + 1}`, step: "transcribe", state: "queued", ...data };
    jobs.push(j);
    return j;
  },
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    where.client.agencyId === "A" ? jobs.find((j) => j.id === where.id) ?? null : null,
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(jobs.find((j) => j.id === where.id)!, data),
});

const { app, operator, polly, nova, otherAgency } = await testApp(repurposeRoutes);
let res = await app.inject({ method: "POST", url: "/repurpose", headers: polly, payload: { sourceVideoId: "long1" } });
assert.equal(res.statusCode, 201, res.body);
const created = RepurposeJobSchema.parse(res.json());
assert.deepEqual(created, { id: "j1", sourceVideoId: "long1", step: "transcribe", state: "queued" });
assert.equal(jobs[0]!.clientId, "caleb");

res = await app.inject({ method: "POST", url: "/repurpose", headers: otherAgency, payload: { sourceVideoId: "long1" } });
assert.equal(res.statusCode, 404);
res = await app.inject({ method: "POST", url: "/repurpose", headers: nova, payload: { sourceVideoId: "long1" } });
assert.equal(res.statusCode, 403);
res = await app.inject({ method: "POST", url: "/repurpose", headers: operator, payload: {} });
assert.equal(res.statusCode, 400);

res = await app.inject({ method: "GET", url: "/repurpose/j1", headers: operator });
assert.equal(res.json().state, "queued");
res = await app.inject({ method: "POST", url: "/repurpose/j1/retry", headers: operator });
assert.equal(res.statusCode, 409, "nothing to retry while queued");

Object.assign(jobs[0]!, { step: "captions", state: "failed", error: "captions service down" });
res = await app.inject({ method: "POST", url: "/repurpose/j1/retry", headers: operator });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { id: "j1", sourceVideoId: "long1", step: "captions", state: "queued" });
assert.equal(jobs[0]!.error, null);
res = await app.inject({ method: "GET", url: "/repurpose/j1", headers: otherAgency });
assert.equal(res.statusCode, 404);

await app.close();
console.log("repurpose.check: ok");
