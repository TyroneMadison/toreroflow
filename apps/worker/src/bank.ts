import { signedCents, toCents } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { decryptSecret, isEncrypted } from "@toreroflow/db";
import { needsReconnect, PlaidClient, PlaidError } from "@toreroflow/publishers";
import { env } from "./env";

/**
 * Pulls the bank feed for one linked connection.
 *
 * Incremental: the provider hands back everything that changed since a stored
 * cursor, in three buckets. All three matter. A transaction can be added,
 * then have its amount or merchant corrected once the bank settles it, then
 * be removed entirely if it was reversed. Applying only the additions is how
 * a total drifts away from the real balance and never comes back.
 *
 * The cursor is saved only after a page is written, so a crash mid-sync
 * repeats a page rather than skipping one. Repeating is harmless because every
 * row is keyed by the provider's own transaction id.
 */

const prisma = getPrisma();

/** Pages before giving up, so a broken feed cannot loop forever. */
const MAX_PAGES = 60;

export async function syncBankConnection(connectionId: string): Promise<void> {
  const connection = await prisma.bankConnection.findUnique({
    where: { id: connectionId },
    include: { accounts: { select: { id: true, plaidAccountId: true } } },
  });
  if (!connection) return;

  const fail = async (message: string, status = "error") => {
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { status, error: message },
    });
    console.error(`[worker] bank sync failed for ${connection.id}: ${message}`);
  };

  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    await fail("Bank oversight needs PLAID_CLIENT_ID and PLAID_SECRET in the repo .env.");
    return;
  }
  if (!isEncrypted(connection.accessTokenEnc)) {
    // Refusing rather than guessing: a value that is not one of our blobs is
    // not something to send to a bank API.
    await fail("This connection's stored token is unreadable. Reconnect the bank.");
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(connection.accessTokenEnc);
  } catch {
    await fail(
      "This connection's token could not be decrypted, which usually means TOKEN_ENCRYPTION_KEY changed. Reconnect the bank.",
    );
    return;
  }

  const plaid = new PlaidClient(env.PLAID_CLIENT_ID, env.PLAID_SECRET, env.PLAID_ENV);
  const accountIdByPlaidId = new Map(connection.accounts.map((a) => [a.plaidAccountId, a.id]));

  let cursor = connection.cursor;
  let added = 0;
  let modified = 0;
  let removed = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await plaid.syncTransactions(accessToken, cursor);

      for (const t of [...res.added, ...res.modified]) {
        const accountId = accountIdByPlaidId.get(t.account_id);
        // A transaction on an account we have never stored: skip rather than
        // invent a parent row, and let the next reconnect pick the account up.
        if (!accountId) continue;

        const data = {
          accountId,
          date: t.date,
          name: t.name,
          merchantName: t.merchant_name,
          // Stored in our convention, positive means money arrived. The
          // provider's sign is inverted; the flip lives in core/banking.ts.
          amountCents: signedCents(t.amount),
          pending: t.pending,
          category: t.personal_finance_category?.primary ?? null,
        };
        await prisma.bankTransaction.upsert({
          where: { plaidTransactionId: t.transaction_id },
          create: { plaidTransactionId: t.transaction_id, ...data },
          update: data,
        });
      }
      added += res.added.length;
      modified += res.modified.length;

      if (res.removed.length) {
        const ids = res.removed.map((r) => r.transaction_id);
        const gone = await prisma.bankTransaction.deleteMany({
          where: { plaidTransactionId: { in: ids } },
        });
        removed += gone.count;
      }

      // Written per page, after the rows: a crash repeats a page instead of
      // losing one, and repeats are idempotent.
      cursor = res.next_cursor;
      await prisma.bankConnection.update({
        where: { id: connection.id },
        data: { cursor },
      });

      if (!res.has_more) break;
    }

    // Balances move independently of transactions, so refresh them too.
    const accounts = await plaid.accounts(accessToken);
    for (const a of accounts) {
      const current = a.balances.current;
      const available = a.balances.available;
      await prisma.bankAccount.updateMany({
        where: { plaidAccountId: a.account_id },
        data: {
          currentCents: current == null ? null : toCents(current),
          availableCents: available == null ? null : toCents(available),
        },
      });
    }

    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { status: "active", error: null, lastSyncedAt: new Date() },
    });
    console.log(
      `[worker] bank sync ${connection.institutionName ?? connection.id}: +${added} ~${modified} -${removed}`,
    );
  } catch (err) {
    const code = err instanceof PlaidError ? err.code : null;
    if (needsReconnect(code)) {
      // Not a failure of ours: the bank wants the operator to log in again.
      // Said in those terms rather than as an error, so it reads as an action
      // rather than something broken.
      await fail(
        "Your bank needs you to log in again. Reconnect it to keep the figures up to date.",
        "needs_reconnect",
      );
      return;
    }
    await fail(err instanceof Error ? err.message : String(err));
  }
}

/** Syncs every connection that is not waiting on the operator. */
export async function syncAllBanks(): Promise<void> {
  const connections = await prisma.bankConnection.findMany({
    where: { status: { not: "needs_reconnect" } },
    select: { id: true },
  });
  for (const c of connections) await syncBankConnection(c.id);
}
