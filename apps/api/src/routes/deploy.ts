import { spawn } from "node:child_process";
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
 * The work happens in a detached script rather than in the request, because
 * rebuilding restarts this very process. A handler that waited for the result
 * would be killed by the thing it was waiting for, and the operator would see
 * a network error from a deploy that actually succeeded.
 */

/** Where the checkout lives on the server. */
const APP_DIR = "/opt/toreroflow";
/** Written by the deploy script, read by the status endpoint. */
const STATE_FILE = "/tmp/toreroflow-deploy.json";

interface DeployState {
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  fromCommit?: string;
  toCommit?: string;
  message?: string;
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
      available: env.IS_PRODUCTION,
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
    if (running?.status === "running") {
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

    // Detached and fully disowned. The script outlives this process, which is
    // the point: restarting the API is part of what it does.
    // spawn, not execFile: execFile buffers output for a callback that will
    // never run, because this process is replaced partway through the script.
    const child = spawn("/bin/sh", [`${APP_DIR}/infra/self-update.sh`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return reply.status(202).send({ started: true });
  });
}
