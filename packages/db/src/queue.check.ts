import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";

/**
 * The pg-boss behaviours this app's queues depend on.
 *
 * Every one of them differs from BullMQ, which is what these queues used to run
 * on, and every one fails silently rather than loudly if it changes: a post
 * published twice, a worker that never fires, a handler reading undefined off
 * the wrong shape. A pg-boss upgrade that moves any of them should fail here
 * rather than in production.
 *
 * Needs a database. Skips when there is not one, so a checkout without
 * Postgres running still passes the suite.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("queue.check.ts: skipped, no DATABASE_URL");
  process.exit(0);
}

const SCHEMA = "pgboss_check";
const boss = new PgBoss({ connectionString: url, schema: SCHEMA });
boss.on("error", () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  await boss.start();

  /* 1. A key must dedupe a queued job. Under the default policy it does not,
   *    and for the publish queue that is a post going out twice. */
  await boss.createQueue("dedupe", { policy: "short" });
  const first = await boss.send("dedupe", { n: 1 }, { singletonKey: "k" });
  const second = await boss.send("dedupe", { n: 2 }, { singletonKey: "k" });
  assert.notEqual(first, null, "the first send with a key is accepted");
  assert.equal(second, null, 'a second send with a live key is dropped under policy "short"');

  /* 1b. ...and two jobs with NO key must NOT dedupe against each other.
   *     The index behind "short" is unique on (name, COALESCE(key, '')), so
   *     keyless jobs all collide on the empty string unless enqueue() hands
   *     each one a key of its own. Sending raw here, the way the library
   *     behaves underneath, is the thing worth pinning: if a future version
   *     stops dropping the second one, enqueue()'s workaround is dead weight
   *     and this says so. */
  const bare1 = await boss.send("dedupe", { n: 1 });
  const bare2 = await boss.send("dedupe", { n: 2 });
  assert.notEqual(bare1, null, "the first keyless send is accepted");
  assert.equal(bare2, null, 'a second keyless send is ALSO dropped under policy "short"');
  const unique1 = await boss.send("dedupe", { n: 3 }, { singletonKey: randomUUID() });
  const unique2 = await boss.send("dedupe", { n: 4 }, { singletonKey: randomUUID() });
  assert.ok(unique1 && unique2, "which is why enqueue() gives a keyless job a key of its own");

  /* 2. A job has to be findable by that key and cancellable, which is how a
   *    scheduled post is called off. */
  const found = await boss.findJobs("dedupe", { key: "k", queued: true });
  assert.equal(found.length, 1, "the queued job is findable by its key");
  // Asserted by looking again rather than by reading the return value, whose
  // CommandResponse type is declared empty upstream.
  await boss.cancel("dedupe", found[0]!.id);
  const gone = await boss.findJobs("dedupe", { key: "k", queued: true });
  assert.equal(gone.length, 0, "cancelling by the id that lookup returned removes it");

  /* 3. Rescheduling has to move the job rather than add a second one. */
  await boss.createQueue("resched", { policy: "short" });
  await boss.send("resched", { t: 1 }, { singletonKey: "t", startAfter: 60 });
  const later = new Date(Date.now() + 3_600_000);
  await boss.upsert("resched", { t: 1 }, { singletonKey: "t", startAfter: later });
  const after = await boss.findJobs("resched", { key: "t", queued: true });
  assert.equal(after.length, 1, "rescheduling leaves exactly one job, not two");
  assert.ok(
    new Date(after[0]!.startAfter).getTime() > Date.now() + 1_800_000,
    "and it really moved to the later time",
  );

  /* 4. The handler is given an array. Written against a single job it would
   *    read undefined off it and quietly do nothing. */
  await boss.createQueue("shape", { policy: "short" });
  await boss.send("shape", { hello: "world" });
  let sawArray: boolean | null = null;
  let payload: unknown = null;
  await boss.work<{ hello: string }>("shape", { batchSize: 1 }, async (jobs) => {
    sawArray = Array.isArray(jobs);
    payload = Array.isArray(jobs) ? jobs[0]?.data : undefined;
  });
  for (let i = 0; i < 30 && sawArray === null; i++) await sleep(500);
  assert.equal(sawArray, true, "a work handler is given an array of jobs, never one job");
  assert.deepEqual(payload, { hello: "world" }, "and the payload survives the round trip");

  console.log("queue.check.ts: ok");
} finally {
  await boss.stop({ graceful: false }).catch(() => {});
  // Drop the scratch schema through the same connection pg-boss used.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
}
