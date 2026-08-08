import { PgBoss } from "pg-boss";

/**
 * The job queues, on Postgres.
 *
 * These ran on Redis through BullMQ. Redis was one of the two reasons this app
 * needs Docker, and it is the reason that cannot be shipped: there is no
 * official Redis build for Windows and the community ports are unmaintained.
 * Postgres has to be there anyway, so the queues moved onto it and Redis is
 * gone rather than bundled.
 *
 * This module is deliberately shaped like the small part of BullMQ the app
 * actually used, so the call sites read the same. pg-boss v12 differs from
 * BullMQ in four ways that each cause a silent bug if you assume otherwise,
 * and all four are handled here rather than at twenty call sites:
 *
 *  1. A queue must be created before anything can be sent to it.
 *  2. A work handler is given an ARRAY of jobs, never one.
 *  3. Deduping a queued job by key needs the queue's policy set to "short".
 *     Under the default policy a second send with the same key is accepted,
 *     which for us would mean a post published twice.
 *  4. The package is ESM with a named export; there is no default export.
 */

/** Every queue in the app. Adding one here is what creates it on boot. */
export const QUEUE_NAMES = [
  "media",
  "publish",
  "analytics",
  "insights",
  "research",
  "bank",
  "edit",
  "analyze",
  "knowledge",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

/**
 * The one connection, started once.
 *
 * Both the API and the worker call this. Its own schema keeps every table
 * pg-boss owns out of the way of the app's, so a Prisma migration and a queue
 * upgrade can never collide.
 */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set, so the job queues cannot start");

    const instance = new PgBoss({ connectionString: url, schema: "pgboss" });
    // Without a listener an internal error takes the process down, and a
    // worker dying quietly is how a schedule stops running for a week before
    // anyone notices.
    instance.on("error", (err) => console.error("[queue]", err));
    await instance.start();

    // "short" is what makes a second send with a live key a no-op, which is
    // the behaviour every caller passing a key is relying on.
    for (const name of QUEUE_NAMES) {
      await instance.createQueue(name, { policy: "short" });
    }

    boss = instance;
    return instance;
  })();

  return starting;
}

export interface EnqueueOptions {
  /**
   * One queued job per key. A second enqueue while the first is still waiting
   * is dropped, which is what stops a double click billing twice or a post
   * going out twice.
   */
  key?: string;
  /** When to run it: seconds from now, or an exact time. */
  startAfter?: number | Date;
  /** How many times to retry a failure, and how long to wait between. */
  retryLimit?: number;
  retryDelaySeconds?: number;
  /**
   * Grow the wait between retries instead of keeping it flat. Publishing uses
   * it: a platform that just refused is unlikely to say yes a second time
   * thirty seconds later, and three evenly spaced retries is closer to
   * hammering it than to backing off.
   */
  retryBackoff?: boolean;
}

/**
 * Queue a job, returning its id.
 *
 * Null means a key was given and a job already holds it, which is a successful
 * no-op rather than a failure. The id is only needed by the one caller that
 * waits for its job to finish; everyone else can ignore it.
 */
export async function enqueue(
  queue: QueueName,
  data: object,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const b = await getBoss();
  return b.send(queue, data, {
    ...(options.key ? { singletonKey: options.key } : {}),
    ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
    ...(options.retryDelaySeconds !== undefined ? { retryDelay: options.retryDelaySeconds } : {}),
    ...(options.retryBackoff !== undefined ? { retryBackoff: options.retryBackoff } : {}),
  });
}

/**
 * Wait for one job to finish, within reason.
 *
 * Only the report rebuild needs this: it kicks off an analytics ingest and has
 * to have the fresh follower snapshots before it renders the page, or it
 * publishes last cycle's numbers. Bounded and never fatal, so a worker that is
 * not running times out and the page is still rebuilt with everything else
 * current rather than the request hanging.
 */
export async function waitForJob(
  queue: QueueName,
  id: string,
  timeoutMs = 30_000,
): Promise<"completed" | "failed" | "timed out"> {
  const b = await getBoss();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await b.getJobById(queue, id);
    if (job?.state === "completed") return "completed";
    if (job?.state === "failed" || job?.state === "cancelled") return "failed";
    await new Promise((r) => setTimeout(r, 400));
  }
  return "timed out";
}

/**
 * Move a queued job to a new time, or queue it if it is not there.
 *
 * One statement rather than cancel-then-add, so a reschedule cannot lose the
 * job in the gap between the two.
 */
export async function reschedule(
  queue: QueueName,
  data: object,
  key: string,
  startAfter: number | Date,
): Promise<void> {
  const b = await getBoss();
  await b.upsert(queue, data, { singletonKey: key, startAfter });
}

/**
 * Drop the queued job holding this key. True when there was one.
 *
 * A job that has already started is left alone: the work is happening, and
 * cancelling the row would not stop it.
 */
export async function cancelByKey(queue: QueueName, key: string): Promise<boolean> {
  const b = await getBoss();
  const jobs = await b.findJobs(queue, { key, queued: true });
  if (!jobs.length) return false;
  // cancel() reports a count at runtime, but its CommandResponse is typed as an
  // empty interface, so reading that field would mean casting around a hole in
  // someone else's types. What was queued is already known from the lookup, and
  // a failure throws, so the count adds nothing.
  await b.cancel(
    queue,
    jobs.map((j) => j.id),
  );
  return true;
}

/** A recurring job, on a cron expression. Re-registering the same one is safe. */
export async function scheduleCron(
  queue: QueueName,
  cron: string,
  data: object = {},
): Promise<void> {
  const b = await getBoss();
  await b.schedule(queue, cron, data);
}

/** What a handler is told about the job beyond its payload. */
export interface JobMeta {
  /**
   * How many times this job has already failed, 0 on the first run.
   *
   * Publishing needs it: it decides whether a failure is the final one and the
   * post should be marked failed for good, or just another attempt. Same
   * meaning and same base as BullMQ's attemptsMade, so callers do not shift.
   */
  retryCount: number;
}

/**
 * Run `handler` for each job on a queue.
 *
 * pg-boss hands the handler a batch; this unwraps it and runs them one at a
 * time so a handler only ever deals with a single job, the way the worker code
 * was already written. `concurrency` is how many are taken per poll.
 *
 * Metadata is always requested, because retryCount only arrives with it and a
 * handler silently receiving undefined there would mark first failures final.
 *
 * A throw propagates, which is what marks the job failed and lets the retry
 * policy do its work. Swallowing it here would turn every failure into a
 * silent success.
 */
export async function work<T extends object>(
  queue: QueueName,
  options: { concurrency?: number },
  handler: (data: T, meta: JobMeta) => Promise<void>,
): Promise<void> {
  const b = await getBoss();
  // All three type parameters are given on purpose. pg-boss picks the
  // with-metadata handler shape from the literal type of the options object, so
  // naming only the payload type leaves the options generic at its default and
  // the job arrives without retryCount on it.
  await b.work<T, void, { batchSize: number; includeMetadata: true }>(
    queue,
    { batchSize: options.concurrency ?? 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) await handler(job.data, { retryCount: job.retryCount });
    },
  );
}

/** Closes the connection. Called when the worker or the API shuts down. */
export async function stopQueues(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true });
  boss = undefined;
  starting = undefined;
}
