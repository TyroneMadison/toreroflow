import {
  estimateCents,
  isResearchPlatform,
  withinBudget,
  type PlannedFetch,
  type ResearchPlatform,
} from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { env } from "./env";
import { MonidProvider, ResearchError, type ResearchProvider } from "./research/monid";

/**
 * One press of the research button: resolve the accounts a client admires,
 * pull what they have been posting, store it.
 *
 * Runs here rather than in a request because provider runs are asynchronous
 * and can take minutes, and because a half-finished fetch should leave a row
 * saying so rather than a dead HTTP connection.
 */

const prisma = getPrisma();

/**
 * What one call costs, in cents.
 *
 * The confirmed tikhub endpoints are $0.0015 per call, so a cent buys about
 * six. Kept as a constant rather than read per run: the ceiling only has to
 * be honest enough to stop a runaway, and the true cost of every call is
 * recorded on the snapshot afterwards.
 */
const CENTS_PER_CALL = 0.15;

/** How many recent posts to ask for per account. */
const POSTS_PER_ACCOUNT = 20;

export async function runResearch(runId: string): Promise<void> {
  const finish = async (status: string, error: string | null, spentCents: number) => {
    await prisma.researchRun.updateMany({
      where: { id: runId },
      data: { status, error, spentCents, completedAt: new Date() },
    });
  };

  let spent = 0;
  try {
    const run = await prisma.researchRun.findUnique({ where: { id: runId } });
    if (!run) return;

    const provider: ResearchProvider | null = env.MONID_API_KEY
      ? new MonidProvider(env.MONID_API_KEY)
      : null;
    if (!provider) {
      await finish(
        "failed",
        "Competitor research needs a MONID_API_KEY in the repo .env, then a worker restart.",
        0,
      );
      return;
    }

    const accounts = await prisma.inspirationAccount.findMany({
      where: { clientId: run.clientId },
      orderBy: { createdAt: "asc" },
    });
    if (!accounts.length) {
      await finish("failed", "This brand has no inspiration accounts to research yet.", 0);
      return;
    }

    const planned: PlannedFetch[] = accounts
      .filter((a) => isResearchPlatform(a.platform))
      .map((a) => ({
        platform: a.platform as ResearchPlatform,
        handle: a.handle,
        resolved: Boolean(a.externalId),
      }));

    // The ceiling is agreed before anything is spent, and what it cannot
    // afford is named rather than quietly dropped.
    const { run: affordable, skipped } = withinBudget(planned, CENTS_PER_CALL, run.maxCents);
    const byHandle = new Map(accounts.map((a) => [`${a.platform}:${a.handle}`, a]));
    let stored = 0;
    const failures: string[] = [];

    for (const p of affordable) {
      const account = byHandle.get(`${p.platform}:${p.handle}`);
      if (!account) continue;
      try {
        let externalId = account.externalId;
        if (!externalId) {
          const resolved = await provider.resolve(p.platform, p.handle);
          externalId = resolved.externalId;
          await prisma.inspirationAccount.update({
            where: { id: account.id },
            data: {
              externalId,
              displayName: account.displayName ?? resolved.displayName,
              error: null,
            },
          });
          spent += Math.ceil(CENTS_PER_CALL);
        }

        const posts = await provider.fetchPosts(p.platform, externalId, POSTS_PER_ACCOUNT);
        spent += posts.costCents || Math.ceil(CENTS_PER_CALL);
        const snapshot = await prisma.competitorSnapshot.create({
          data: {
            accountId: account.id,
            runId,
            raw: posts.raw as Prisma.InputJsonValue,
            costCents: posts.costCents,
          },
        });
        /*
         * The new pull replaces the old one for this account.
         *
         * A payload is the provider's answer stored verbatim, which runs about
         * 160KB for a single Instagram account, and every reader takes the
         * newest one only. Keeping every past pull grows the database by that
         * much per account per press and buys nothing: an older pull describes
         * the same person, less well.
         */
        await prisma.competitorSnapshot.deleteMany({
          where: { accountId: account.id, id: { not: snapshot.id } },
        });
        stored += 1;
      } catch (err) {
        // One bad handle must not lose the accounts that worked. The reason
        // lands on the account so it explains itself next time it is opened.
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`@${p.handle} on ${p.platform}: ${message}`);
        await prisma.inspirationAccount.updateMany({
          where: { id: account.id },
          data: { error: message },
        });
        if (err instanceof ResearchError && err.outOfCredit) {
          await finish("failed", message, spent);
          return;
        }
      }
    }

    // A run that stored nothing is a failed run, whatever happened on the way.
    // Reporting "ready" over an empty result is how an operator ends up
    // trusting a game plan built on no data at all.
    if (stored === 0) {
      await finish(
        "failed",
        failures[0] ?? "Nothing could be pulled for these accounts.",
        spent,
      );
      return;
    }

    const notes = [
      failures.length ? `${failures.length} account${failures.length === 1 ? "" : "s"} could not be pulled.` : null,
      skipped.length
        ? `Stopped at the spending limit with ${skipped.length} account${skipped.length === 1 ? "" : "s"} left. Raise the limit and run again to finish.`
        : null,
    ].filter(Boolean);
    await finish("ready", notes.length ? notes.join(" ") : null, spent);
    console.log(`[worker] research done for ${run.clientId}: ${stored} stored, ${spent}c spent`);
  } catch (err) {
    await finish("failed", err instanceof Error ? err.message : String(err), spent);
  }
}

/** What a run would cost before it starts, so the button can say so. */
export function quoteCents(planned: PlannedFetch[]): number {
  return estimateCents(planned, CENTS_PER_CALL);
}
