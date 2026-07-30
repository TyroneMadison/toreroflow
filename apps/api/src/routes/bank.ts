import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  isCashAccount,
  monthWindowStart,
  toCents,
  totalsFor,
  totalsByMonth,
} from "@toreroflow/core";
import { decryptSecret, encryptSecret, getPrisma, isEncrypted } from "@toreroflow/db";
import { env } from "../env";
import { PlaidClient } from "@toreroflow/publishers";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Bank oversight: read-only balances and transactions for the agency's own
 * account.
 *
 * There is no endpoint here that moves money, and there should never be one.
 * The bank login itself happens entirely inside the provider's widget against
 * the bank's own page, so no banking credential ever reaches this app.
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

  const configured = (): boolean => Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
  const client = () => new PlaidClient(env.PLAID_CLIENT_ID, env.PLAID_SECRET, env.PLAID_ENV);

  const notConfigured = {
    error: "bank oversight unavailable",
    detail:
      "Set PLAID_CLIENT_ID and PLAID_SECRET in the repo root .env and restart the API to connect a bank.",
  } as const;

  /** Whether the feature is on, and what is currently linked. */
  app.get("/bank/connections", async (request) => {
    const connections = await prisma.bankConnection.findMany({
      where: { agencyId: request.user.agencyId },
      orderBy: { createdAt: "asc" },
      include: { accounts: { orderBy: { name: "asc" } } },
    });
    return {
      configured: configured(),
      environment: env.PLAID_ENV,
      reason: configured() ? null : notConfigured.detail,
      connections: connections.map((c) => ({
        id: c.id,
        institutionName: c.institutionName,
        status: c.status,
        error: c.error,
        lastSyncedAt: c.lastSyncedAt,
        /** Never leaves the server, so the client cannot leak it. */
        accounts: c.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          officialName: a.officialName,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          currentCents: a.currentCents,
          availableCents: a.availableCents,
          currency: a.currency,
          includeInCashFlow: a.includeInCashFlow,
        })),
      })),
    };
  });

  /** A short-lived token the desktop app hands to the bank picker. */
  app.post("/bank/link-token", async (request, reply) => {
    if (!configured()) return reply.status(503).send(notConfigured);
    try {
      const linkToken = await client().createLinkToken(request.user.agencyId);
      return { linkToken, environment: env.PLAID_ENV };
    } catch (err) {
      app.log.error({ err }, "could not create a bank link token");
      return reply.status(502).send({
        error: "could not start the bank connection",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * A token that repairs an existing link rather than making a new one.
   *
   * This is the only correct answer to a bank asking for a fresh login. Banks
   * do that routinely, every few months. Connecting again from scratch creates
   * a second link to the same bank, and since both copies of the accounts
   * default into cash flow, money in and money out both double. Repairing keeps
   * the same link, so the stored history and the operator's cash-flow choices
   * survive untouched.
   */
  app.post<{ Params: { id: string } }>(
    "/bank/connections/:id/relink",
    async (request, reply) => {
      if (!configured()) return reply.status(503).send(notConfigured);
      const connection = await prisma.bankConnection.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId },
        select: { accessTokenEnc: true },
      });
      if (!connection) return reply.status(404).send({ error: "connection not found" });
      if (!isEncrypted(connection.accessTokenEnc)) {
        return reply.status(409).send({
          error: "this connection cannot be repaired",
          detail: "Its stored token is unreadable. Disconnect the bank and connect it again.",
        });
      }
      try {
        const linkToken = await client().createLinkToken(
          request.user.agencyId,
          decryptSecret(connection.accessTokenEnc),
        );
        return { linkToken, environment: env.PLAID_ENV };
      } catch (err) {
        app.log.error({ err }, "could not create a bank relink token");
        return reply.status(502).send({
          error: "could not start the reconnection",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * Finishes a connection.
   *
   * The one-time token from the widget is traded for the long-lived access
   * token, which is encrypted before it is written. Accounts are stored so the
   * operator can pick which ones count as cash flow, defaulting from the
   * account type: a single link returns a mortgage, a 401k and student loans
   * alongside the business checking account.
   */
  app.post<{ Body: { publicToken?: string } }>("/bank/exchange", async (request, reply) => {
    if (!configured()) return reply.status(503).send(notConfigured);
    const publicToken = request.body?.publicToken;
    if (!publicToken) return reply.status(400).send({ error: "publicToken is required" });

    try {
      const plaid = client();
      const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);
      const [accounts, institution] = await Promise.all([
        plaid.accounts(accessToken),
        plaid.institution(accessToken),
      ]);

      /*
       * A second link to a bank that is already connected is refused.
       *
       * Both copies of the accounts would default into cash flow, so money in
       * and money out would silently double. Measured on the sandbox: $1,512.66
       * became $3,025.32. Refusing loses nothing, because Reconnect repairs the
       * existing link in place and Disconnect removes it deliberately.
       *
       * Keyed on the bank's id, never on a null: two connections whose lookup
       * failed are not evidence of the same bank.
       */
      if (institution.id) {
        const already = await prisma.bankConnection.findFirst({
          where: {
            agencyId: request.user.agencyId,
            institutionId: institution.id,
            itemId: { not: itemId },
          },
          select: { id: true, institutionName: true, status: true },
        });
        if (already) {
          // The link exists at the provider by now, so refusing it here would
          // leave it alive and billable with nothing pointing at it. Revoke it
          // before answering. Best effort: the refusal is the important part.
          try {
            await plaid.removeItem(accessToken);
          } catch (err) {
            app.log.error({ err }, "could not revoke the duplicate bank link");
          }
          return reply.status(409).send({
            error: `${already.institutionName ?? "That bank"} is already connected`,
            detail:
              already.status === "needs_reconnect"
                ? "Press Reconnect on it instead. Connecting again would add a second copy of every account and double the figures."
                : "Connecting it again would add a second copy of every account and double the figures. Disconnect it first if you want to start over.",
          });
        }
      }

      // Upsert on itemId: repairing an existing link comes back with the same
      // item, so this updates the row rather than stacking a second copy of
      // every account.
      const connection = await prisma.bankConnection.upsert({
        where: { itemId },
        create: {
          agencyId: request.user.agencyId,
          itemId,
          institutionId: institution.id,
          institutionName: institution.name,
          accessTokenEnc: encryptSecret(accessToken),
          status: "active",
        },
        update: {
          institutionId: institution.id,
          institutionName: institution.name,
          accessTokenEnc: encryptSecret(accessToken),
          status: "active",
          error: null,
        },
      });

      for (const a of accounts) {
        const current = a.balances.current;
        const available = a.balances.available;
        await prisma.bankAccount.upsert({
          where: { plaidAccountId: a.account_id },
          create: {
            connectionId: connection.id,
            plaidAccountId: a.account_id,
            name: a.name,
            officialName: a.official_name,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
            currentCents: current == null ? null : toCents(current),
            availableCents: available == null ? null : toCents(available),
            currency: a.balances.iso_currency_code ?? "USD",
            includeInCashFlow: isCashAccount(a.type),
          },
          update: {
            name: a.name,
            officialName: a.official_name,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
            currentCents: current == null ? null : toCents(current),
            availableCents: available == null ? null : toCents(available),
            currency: a.balances.iso_currency_code ?? "USD",
            // includeInCashFlow deliberately left alone on update: it is the
            // operator's choice and a reconnect must not silently undo it.
          },
        });
      }

      return reply.status(201).send({
        id: connection.id,
        institutionName: connection.institutionName,
        accounts: accounts.length,
      });
    } catch (err) {
      app.log.error({ err }, "could not finish the bank connection");
      return reply.status(502).send({
        error: "could not finish the bank connection",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Whether an account counts towards money in and money out. */
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

    // Stored in our own convention already (positive means money arrived), so
    // the totals helper is fed the sign it expects by undoing that once here.
    const forTotals = rows.map((r) => ({
      amount: -r.amountCents / 100,
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
   * Queued rather than done here: the feed is paged and can take a while, and
   * a request that holds open for it would time out on a first sync. One job
   * per connection at a time, keyed by its id, so an impatient second press
   * joins the run already going instead of starting a competing one.
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
      // rejects custom ids containing one. The connection id alone is already
      // unique, and the queue name scopes it.
      { jobId: found.id, removeOnComplete: true, removeOnFail: true },
    );
    return reply.status(202).send({ queued: true });
  });

  /** Forgets a bank entirely, transactions and all. */
  app.delete<{ Params: { id: string } }>("/bank/connections/:id", async (request, reply) => {
    const connection = await prisma.bankConnection.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true, accessTokenEnc: true },
    });
    if (!connection) return reply.status(404).send({ error: "connection not found" });

    /*
     * Revoked at the provider first, then deleted here.
     *
     * Forgetting the row without this would leave a live link to a real bank
     * standing at the provider, with the only key to it gone from our side, and
     * a monthly charge for a connection nobody is watching. The operator asked
     * for it to be gone.
     *
     * Best effort on purpose: if the provider is unreachable, the local delete
     * still happens, because refusing to disconnect while a third party is down
     * is worse than a link that outlives the row. It is logged when it happens.
     */
    if (configured() && isEncrypted(connection.accessTokenEnc)) {
      try {
        await client().removeItem(decryptSecret(connection.accessTokenEnc));
      } catch (err) {
        app.log.error({ err }, "could not revoke the bank link at the provider");
      }
    }

    // Cascades to accounts and transactions: unlinking a bank should not leave
    // its transaction history sitting in the database.
    await prisma.bankConnection.delete({ where: { id: connection.id } });
    return { ok: true };
  });
}
