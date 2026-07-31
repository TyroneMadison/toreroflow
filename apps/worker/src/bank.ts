import { businessDay, signedCents, toCents } from "@toreroflow/core";
import { env } from "./env";
import { decryptSecret, getPrisma, isEncrypted } from "@toreroflow/db";
import { BankError, fetchAccounts, redactCredentials } from "@toreroflow/publishers";

/**
 * Pulls the bank feed for one linked connection.
 *
 * SimpleFIN is queried by date range, not by change cursor, and the protocol
 * caps a range at 90 days. So a sync walks forward in windows from where it
 * last finished and records the day it reached. Re-reading a day is harmless:
 * every row is keyed by the provider's own transaction id, so a repeat is an
 * update rather than a duplicate.
 *
 * The first sync of a new connection has nowhere to start from and takes a
 * year, which is five windows. Later syncs start a week before the last day
 * read, because a card transaction can post several days after it happened and
 * a window starting exactly where the last one ended would miss it for good.
 */

const prisma = getPrisma();

/**
 * Days per request.
 *
 * The protocol allows 90, but the server answers anything over 45 with a
 * warning that it may start capping. That warning arrives in the same list as
 * real problems and lands on the operator's screen in red, so the window sits
 * at the number the server is happy with rather than the number it permits.
 */
const WINDOW_DAYS = 45;
/** How far back a first sync reaches. */
const FIRST_SYNC_DAYS = 365;
/** Days re-read on every sync, so late-posting rows are not lost. */
const OVERLAP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day the business had, not UTC's. See packages/core/src/banking.ts. */
const iso = (d: Date): string => businessDay(d, env.BUSINESS_TIMEZONE);

export async function syncBankConnection(connectionId: string): Promise<void> {
  const connection = await prisma.bankConnection.findUnique({
    where: { id: connectionId },
    include: { accounts: { select: { id: true, providerAccountId: true } } },
  });
  if (!connection) return;

  /**
   * Writes to the connection row, and reports whether it is still there.
   *
   * updateMany rather than update because a pull takes minutes and the operator
   * can press Disconnect during one. update() throws when the row has gone,
   * which killed the job with a Prisma stack trace instead of letting a
   * cancelled pull just stop. Nothing here is worth an error: they asked for
   * the bank to be forgotten and it was.
   */
  const mark = async (data: Record<string, unknown>): Promise<boolean> => {
    const { count } = await prisma.bankConnection.updateMany({
      where: { id: connection.id },
      data,
    });
    return count > 0;
  };

  const fail = async (message: string, status = "error") => {
    // Redacted here rather than at each call site: this column is rendered on
    // screen, and an access URL reaching it puts a live bank credential there.
    const safe = redactCredentials(message);
    if (!(await mark({ status, error: safe }))) {
      // The row went while the pull was mid-flight, which means Disconnect was
      // pressed. Whatever the pull then tripped over on its way out is a
      // consequence of that, not a failure worth a stack trace in the log.
      console.log(`[worker] bank sync stopped: ${connection.id} was disconnected mid-pull`);
      return;
    }
    console.error(`[worker] bank sync failed for ${connection.id}: ${safe}`);
  };

  if (!isEncrypted(connection.accessTokenEnc)) {
    // Refusing rather than guessing: a value that is not one of our blobs is
    // not something to send anywhere.
    await fail("This connection's stored address is unreadable. Connect the bank again.");
    return;
  }

  let accessUrl: string;
  try {
    accessUrl = decryptSecret(connection.accessTokenEnc);
  } catch {
    await fail(
      "This connection could not be decrypted, which usually means TOKEN_ENCRYPTION_KEY changed. Connect the bank again.",
    );
    return;
  }

  const now = new Date();
  const startFrom = connection.syncedThrough
    ? new Date(new Date(`${connection.syncedThrough}T00:00:00Z`).getTime() - OVERLAP_DAYS * DAY_MS)
    : new Date(now.getTime() - FIRST_SYNC_DAYS * DAY_MS);

  let written = 0;
  let accountsSeen = 0;
  const problems: string[] = [];

  try {
    const accountRowId = new Map(connection.accounts.map((a) => [a.providerAccountId, a.id]));

    // Oldest window first, so an interruption leaves syncedThrough pointing at
    // real coverage rather than at a gap.
    for (
      let windowStart = startFrom;
      windowStart < now;
      windowStart = new Date(windowStart.getTime() + WINDOW_DAYS * DAY_MS)
    ) {
      const windowEnd = new Date(
        Math.min(now.getTime(), windowStart.getTime() + WINDOW_DAYS * DAY_MS),
      );
      const { accounts, notes } = await fetchAccounts(accessUrl, windowStart, windowEnd);
      problems.push(...notes);
      accountsSeen = Math.max(accountsSeen, accounts.length);

      for (const a of accounts) {
        // An account discovered mid-sync gets a row rather than having its
        // transactions dropped. New accounts start counted, because the feed
        // reports no type to decide from.
        let rowId = accountRowId.get(a.id);
        if (!rowId) {
          const created = await prisma.bankAccount.upsert({
            where: {
              connectionId_providerAccountId: {
                connectionId: connection.id,
                providerAccountId: a.id,
              },
            },
            create: {
              connectionId: connection.id,
              providerAccountId: a.id,
              name: a.name,
              currency: a.currency,
            },
            update: { name: a.name },
            select: { id: true },
          });
          rowId = created.id;
          accountRowId.set(a.id, rowId);
        }

        for (const t of a.transactions) {
          // `posted` is 0 while a row is pending, so there is no day to file it
          // under. Today is the honest placeholder, and pending rows are
          // excluded from every total anyway.
          const date = t.posted ? iso(new Date(t.posted * 1000)) : iso(now);
          const data = {
            accountId: rowId,
            date,
            name: t.description || "Transaction",
            merchantName: null,
            // Our convention, positive means money arrived. The conversion
            // lives in packages/core/src/banking.ts.
            amountCents: signedCents(t.amount),
            pending: t.pending,
          };
          await prisma.bankTransaction.upsert({
            where: {
              accountId_providerTransactionId: {
                accountId: rowId,
                providerTransactionId: t.id,
              },
            },
            create: { providerTransactionId: t.id, ...data },
            update: data,
          });
          written += 1;
        }

        // Balances move independently of transactions, so take the latest.
        // Keyed on our own row id: an account id is only unique inside its
        // connection, so matching on it alone would write another bank's
        // balance onto this one.
        await prisma.bankAccount.update({
          where: { id: rowId },
          data: {
            currentCents: a.balance == null ? null : toCents(a.balance),
            availableCents: a.availableBalance == null ? null : toCents(a.availableBalance),
          },
        });
      }

      // Written per window, after its rows: an interruption repeats a window
      // rather than skipping one, and repeats are idempotent. A row that has
      // gone means the operator disconnected mid-pull, so stop rather than
      // spend more of their daily request allowance on a bank they unlinked.
      if (!(await mark({ syncedThrough: iso(windowEnd) }))) {
        console.log(`[worker] bank sync stopped: ${connection.id} was disconnected mid-pull`);
        return;
      }
    }

    await mark({
      status: "active",
      // The provider's own advisories are kept. An account it could not read
      // comes back as an empty list, and without this the screen would show a
      // confident zero with nothing to explain it. Status stays "active", and
      // that is how the screen knows to show these as a note rather than as a
      // failure: a pull that said something is not a pull that broke.
      error: problems.length ? [...new Set(problems)].join(" ") : null,
      lastSyncedAt: new Date(),
    });
    console.log(
      `[worker] bank sync ${connection.institutionName ?? connection.id}: ${written} rows across ${accountsSeen} account(s)`,
    );
  } catch (err) {
    if (err instanceof BankError && err.needsReconnect) {
      // Not a failure of ours: SimpleFIN wants the operator to reconnect.
      await fail(
        "SimpleFIN needs you to connect this bank again. Generate a new setup token and paste it in.",
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
