import { promises as fsp } from "node:fs";
import type { FastifyInstance } from "fastify";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The Ship button.
 *
 * Pulls whatever is on the repository's main branch and rebuilds the server
 * from it. That is the whole scope, and the limit is worth stating plainly:
 * this ships what is committed and pushed, not what is sitting unsaved on a
 * laptop. The API has no access to anyone's working tree and should not.
 *
 * This process cannot do the work itself and deliberately cannot be given the
 * ability to. It runs in a container with no git, no docker and no checkout.
 * The shortcut is to mount the docker socket in here, which also hands this
 * container root on the host, and this container holds a bank credential and
 * answers the internet. So instead it drops a file in a directory shared with
 * the host, and a watcher there does the work. See infra/deploy-watcher.sh.
 *
 * That also solves a second problem for free: rebuilding restarts this very
 * process, so a handler that waited for the result would be killed by the
 * thing it was waiting for.
 */

/** Shared with the host. The API may write a request and read the state. */
const SHARED = "/app/deploy";
const REQUEST_FILE = `${SHARED}/request`;
const STATE_FILE = `${SHARED}/state.json`;

interface DeployState {
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  fromCommit?: string;
  toCommit?: string;
  message?: string;
}

/** Whether the host-side watcher has ever set the shared directory up. */
async function watcherPresent(): Promise<boolean> {
  try {
    await fsp.access(SHARED);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<DeployState | null> {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, "utf8")) as DeployState;
  } catch {
    return null;
  }
}

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  /** What the last deploy did, and whether one is running now. */
  app.get("/deploy/status", async () => {
    const state = await readState();
    return {
      /** False on a laptop, where there is nothing to deploy to. */
      // False on a laptop, and false on a server where the watcher is not
      // installed, because a button that silently does nothing is worse than a
      // button that is not there.
      available: env.IS_PRODUCTION && (await watcherPresent()),
      current: env.GIT_COMMIT || null,
      last: state,
    };
  });

  /**
   * Pull and rebuild.
   *
   * 202 rather than 200: the work has been accepted, not finished. The caller
   * polls /deploy/status, which is also how it survives this process being
   * replaced halfway through.
   */
  app.post("/deploy", async (_request, reply) => {
    if (!env.IS_PRODUCTION) {
      return reply.status(400).send({
        error: "not deployable",
        detail:
          "This API is running from a working copy, not a server checkout. Deploying would overwrite local changes with whatever is on main.",
      });
    }

    const running = await readState();
    const stale =
      running?.status === "running" &&
      Date.now() - new Date(running.startedAt).getTime() > 15 * 60 * 1000;
    if (running?.status === "running" && !stale) {
      // A second press while the first is still going would have two builds
      // fighting over the same containers.
      return reply.status(409).send({
        error: "a deploy is already running",
        detail: `Started ${running.startedAt}.`,
      });
    }

    await fsp.writeFile(
      STATE_FILE,
      JSON.stringify({ status: "running", startedAt: new Date().toISOString() }),
      "utf8",
    );

    // The entire privilege this endpoint has: writing one file.
    await fsp.writeFile(REQUEST_FILE, new Date().toISOString(), "utf8");

    return reply.status(202).send({ started: true });
  });
}
