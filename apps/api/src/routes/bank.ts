import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { monthWindowStart, toCents, totalsFor, totalsByMonth } from "@toreroflow/core";
import { encryptSecret, getPrisma } from "@toreroflow/db";
import { BankError, claimSetupToken, fetchAccounts } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Bank oversight: read-only balances and transactions for the agency's own
 * account.
 *
 * There is no endpoint here that moves money, and there should never be one.
 * With SimpleFIN that is a property of the protocol rather than a rule this
 * file keeps: the provider has exactly one endpoint and it is a GET.
 *
 * The bank login happens on SimpleFIN's own site. What arrives here is a
 * single-use setup token, claimed once for an access URL. That URL is the only
 * secret held, and it is encrypted at rest like every other one.
 */

export async function bankRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const bankQueue = new Queue<{ connectionId?: string }>("bank", { connection });

  app.addHook("onRequest", requireAuth);
  app.addHook("onClose", async () => {
    await bankQueue.close();
    connection.disconnect();
  });

  /** What is currently linked. There are no app-level credentials to check. */
  app.get("/bank/connections", async (request) => {
    const connections = await prisma.bankConnection.findMany({
      where: { agencyId: request.user.agencyId },
      orderBy: { createdAt: "asc" },
      include: { accounts: { orderBy: { name: "asc" } } },
    });
    return {
      connections: connections.map((c) => ({
        id: c.id,
        institutionName: c.institutionName,
        status: c.status,
        error: c.error,
        lastSyncedAt: c.lastSyncedAt,
        accounts: c.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          mask: a.mask,
          currentCents: a.currentCents,
          availableCents: a.availableCents,
          currency: a.currency,
          includeInCashFlow: a.includeInCashFlow,
        })),
      })),
    };
  });

  /**
   * Connect a bank from a SimpleFIN setup token.
   *
   * The token is single use, so the access URL it yields is written before
   * anything else can fail: losing it means going back to SimpleFIN for another
   * one. Accounts are read straight away so the screen has something in it, but
   * a failure there leaves the connection in place to be synced rather than
   * throwing away a claim that cannot be repeated.
   */
  app.post<{ Body: { setupToken?: string } }>("/bank/connect", async (request, reply) => {
    const setupToken = (request.body?.setupToken ?? "").trim();

    let accessUrl: string;
    try {
      accessUrl = await claimSetupToken(setupToken);
    } catch (err) {
      return reply.status(400).send({
        error: "could not connect the bank",
        detail: err instanceof BankError ? err.message : "That setup token was not accepted.",
      });
    }

    // Identity for the link. The access URL is itself a credential, so the
    // stored id is the address with the credentials stripped out: stable per
    // connection, and enough to stop one token becoming two rows.
    const itemId = accessUrl.replace(/^https?:\/\/[^@/]*@/, "").slice(0, 190);

    const existing = await prisma.bankConnection.findUnique({ where: { itemId } });
    if (existing && existing.agencyId !== request.user.agencyId) {
      return reply.status(409).send({ error: "that connection belongs to another workspace" });
    }

    const row = await prisma.bankConnection.upsert({
      where: { itemId },
      create: {
        agencyId: request.user.agencyId,
        itemId,
        accessTokenEnc: encryptSecret(accessUrl),
        status: "active",
      },
      update: { accessTokenEnc: encryptSecret(accessUrl), status: "active", error: null },
    });

    // One read now, so the operator sees their accounts immediately rather
    // than an empty card and a button to press.
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const { accounts, errors } = await fetchAccounts(accessUrl, start, end);

      for (const a of accounts) {
        const balances = {
          name: a.name,
          currency: a.currency,
          currentCents: a.balance == null ? null : toCents(a.balance),
          availableCents: a.availableBalance == null ? null : toCents(a.availableBalance),
        };
        await prisma.bankAccount.upsert({
          where: { providerAccountId: a.id },
          create: { connectionId: row.id, providerAccountId: a.id, ...balances },
          update: balances,
        });
      }

      await prisma.bankConnection.update({
        where: { id: row.id },
        data: {
          institutionName: accounts.find((a) => a.orgName)?.orgName ?? null,
          error: errors.length ? errors.join(" ") : null,
        },
      });
    } catch (err) {
      // The claim succeeded, so the connection stays. Saying why beats
      // discarding a token that cannot be claimed twice.
      await prisma.bankConnection.update({
        where: { id: row.id },
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    // Queue a full pull so history arrives without another press.
    await bankQueue.add(
      "sync",
      { connectionId: row.id },
      { jobId: row.id, removeOnComplete: true, removeOnFail: true },
    );

    return reply.status(201).send({ id: row.id });
  });

  app.patch<{ Params: { id: string }; Body: { includeInCashFlow?: boolean } }>(
    "/bank/accounts/:id",
    async (request, reply) => {
      const account = await prisma.bankAccount.findFirst({
        where: { id: request.params.id, connection: { agencyId: request.user.agencyId } },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: "account not found" });
      const updated = await prisma.bankAccount.update({
        where: { id: account.id },
        data: { includeInCashFlow: Boolean(request.body?.includeInCashFlow) },
        select: { id: true, includeInCashFlow: true },
      });
      return updated;
    },
  );

  /**
   * Money in and money out from the linked accounts.
   *
   * Only accounts the operator marked as cash flow, and never pending rows:
   * a pending charge can change amount or vanish, and a figure that quietly
   * restates itself is worse than one that arrives a day late.
   */
  app.get<{ Querystring: { months?: string } }>("/bank/cashflow", async (request) => {
    const months = Math.min(24, Math.max(1, Number(request.query.months ?? 6) || 6));
    const sinceKey = monthWindowStart(months);

    const rows = await prisma.bankTransaction.findMany({
      where: {
        date: { gte: sinceKey },
        account: {
          includeInCashFlow: true,
          connection: { agencyId: request.user.agencyId },
        },
      },
      select: { date: true, amountCents: true, pending: true, name: true, merchantName: true },
      orderBy: { date: "desc" },
    });

    /*
     * Stored cents are already our convention, and the feed now signs the same
     * way, so this is a straight conversion back to dollars.
     *
     * It used to negate here, because the old provider reported a positive
     * amount when money left. Leaving that negation in place would have turned
     * every payment out into income on this screen.
     */
    const forTotals = rows.map((r) => ({
      amount: r.amountCents / 100,
      date: r.date,
      pending: r.pending,
    }));

    const totals = totalsFor(forTotals);
    const byMonth = [...totalsByMonth(forTotals)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, t]) => ({ month, ...t }));

    return {
      months,
      totals,
      byMonth,
      recent: rows.slice(0, 40).map((r) => ({
        date: r.date,
        name: r.merchantName ?? r.name,
        amountCents: r.amountCents,
        pending: r.pending,
      })),
    };
  });

  /**
   * Pulls the latest transactions.
   *
   * Queued rather than done here: a first pull walks a year in 90 day windows
   * and would time out a request. One job per connection at a time, keyed by
   * its id, so an impatient second press joins the run already going.
   */
  app.post<{ Params: { id: string } }>("/bank/connections/:id/sync", async (request, reply) => {
    const found = await prisma.bankConnection.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send({ error: "connection not found" });
    await bankQueue.add(
      "sync",
      { connectionId: found.id },
      // No colon in the job id: the queue uses it as a key separator and
      // rejects custom ids containing one.
      { jobId: found.id, removeOnComplete: true, removeOnFail: true },
    );
    return reply.status(202).send({ queued: true });
  });

  /**
   * Forgets a bank entirely, transactions and all.
   *
   * There is nothing to revoke at the provider: SimpleFIN has no such endpoint,
   * and the access token is disabled by the operator on their own SimpleFIN
   * page. Deleting here destroys our copy of the credential, which is the part
   * this app is responsible for, and the response says where to do the rest.
   */
  app.delete<{ Params: { id: string } }>("/bank/connections/:id", async (request, reply) => {
    const found = await prisma.bankConnection.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send({ error: "connection not found" });

    // Cascades to accounts and transactions: unlinking a bank should not leave
    // its transaction history sitting in the database.
    await prisma.bankConnection.delete({ where: { id: found.id } });
    return { ok: true, revokeAt: "https://bridge.simplefin.org/" };
  });
}
