import type { PrismaClient } from "@prisma/client";

/**
 * Posts still to go out move to the account that replaced a removed one.
 *
 * Replacing an account is two steps for the operator: remove the old one,
 * connect the new one (in either order). Without this, everything already on
 * the calendar kept pointing at the removed row and failed at its time, and
 * the calendar showed the old handle until then. Run whenever accounts change
 * (removed, synced) and once more just before a post goes out.
 *
 * A replacement is an account NEW to the brand around the removal: connected
 * after the account it replaces, within a day before the removal or any time
 * after it. An account the brand already had
 * is a destination the operator chose to keep separate, so nothing ever moves
 * onto one; neither does the removed account itself coming back through a
 * sync (same provider account), nor a reminder account, which is posted by hand.
 */

export interface RehomeAccount {
  id: string;
  platform: string;
  status: string;
  deletedAt: Date | null;
  createdAt: Date;
  tokensEncrypted: string | null;
  providerAccountId: string | null;
}

/** How long before a removal a newly connected account still counts as its replacement. */
export const REPLACEMENT_WINDOW_MS = 24 * 3_600_000;

/** An account this app can actually post to. Reminder accounts are posted by hand. */
const canPost = (a: RehomeAccount) => a.deletedAt === null && a.status === "connected" && a.tokensEncrypted !== "reminder";

/** A removed account whose posts went through the API, so they can follow a replacement. Reminder rows have no provider id. */
export const isRehomeSource = (a: RehomeAccount) => a.deletedAt !== null && a.providerAccountId !== null;

export type Replacement = { kind: "move"; id: string } | { kind: "already"; id: string };

/**
 * What happens to a removed account's waiting target: move to its one
 * replacement, or, when the post already goes to that replacement, nothing is
 * left to send (the copy for the removed account is redundant). Null when
 * there is no replacement yet, or several, and the operator decides.
 *
 * `removedProviderIds` is every removed account's provider id for the brand:
 * any of them coming back through a sync is a removed account, not a new one.
 */
export function replacementFor(
  removed: RehomeAccount,
  accounts: RehomeAccount[],
  alreadyOnPost: Set<string>,
  removedProviderIds: Set<string> = new Set(removed.providerAccountId ? [removed.providerAccountId] : []),
): Replacement | null {
  if (!isRehomeSource(removed)) return null;
  const from = removed.deletedAt!.getTime() - REPLACEMENT_WINDOW_MS;
  // Counted before looking at the post, so "exactly one" means one for every post alike.
  const candidates = accounts.filter(
    (a) =>
      a.platform === removed.platform &&
      canPost(a) &&
      !(a.providerAccountId && removedProviderIds.has(a.providerAccountId)) &&
      a.createdAt.getTime() > removed.createdAt.getTime() &&
      a.createdAt.getTime() >= from,
  );
  if (candidates.length !== 1) return null;
  const id = candidates[0]!.id;
  return alreadyOnPost.has(id) ? { kind: "already", id } : { kind: "move", id };
}

/**
 * Ids in a Drive auto-post account list, with removed ones swapped for their
 * replacement. A removed one with no replacement yet stays, so connecting the
 * replacement later still swaps it in; the worker skips it until then.
 */
export function rehomeIds(ids: string[], accounts: RehomeAccount[]): string[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const removedPids = new Set(accounts.filter(isRehomeSource).map((a) => a.providerAccountId!));
  const out: string[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    const r = a && isRehomeSource(a) ? replacementFor(a, accounts, new Set([...ids, ...out]), removedPids) : null;
    // Already ticked: the removed one just drops off.
    out.push(r ? r.id : id);
  }
  return [...new Set(out)];
}

export interface RehomeResult {
  /** Posts that now go to the replacement instead (moved, or already going there), and its handle. */
  moved: number;
  movedTo: string[];
  /** Targets still waiting on a removed account with no replacement yet. */
  stranded: number;
}

/**
 * Moves one client's waiting targets off removed accounts. With `onlyFrom`, the
 * tally counts that account's targets alone (the one just removed); every
 * removed account is still rehomed.
 */
export async function rehomeTargets(prisma: PrismaClient, clientId: string, onlyFrom?: string): Promise<RehomeResult> {
  const accounts = await prisma.socialAccount.findMany({
    where: { clientId },
    select: {
      id: true,
      platform: true,
      status: true,
      deletedAt: true,
      createdAt: true,
      tokensEncrypted: true,
      providerAccountId: true,
      handle: true,
    },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sources = accounts.filter(isRehomeSource).map((a) => a.id);
  const removedPids = new Set(accounts.filter(isRehomeSource).map((a) => a.providerAccountId!));
  const result: RehomeResult = { moved: 0, movedTo: [], stranded: 0 };
  if (sources.length) {
    const waiting = await prisma.postTarget.findMany({
      where: { status: "scheduled", socialAccountId: { in: sources }, post: { clientId, deletedAt: null } },
      select: { id: true, postId: true, socialAccountId: true },
    });
    for (const t of waiting) {
      const counts = !onlyFrom || t.socialAccountId === onlyFrom;
      const siblings = await prisma.postTarget.findMany({ where: { postId: t.postId }, select: { socialAccountId: true } });
      const r = replacementFor(byId.get(t.socialAccountId)!, accounts, new Set(siblings.map((s) => s.socialAccountId)), removedPids);
      if (!r) {
        if (counts) result.stranded += 1;
        continue;
      }
      // Guarded on status and account, so a target that started publishing or was moved meanwhile is left alone.
      const guard = { id: t.id, status: "scheduled" as const, socialAccountId: t.socialAccountId };
      const res =
        r.kind === "move"
          ? await prisma.postTarget.updateMany({ where: guard, data: { socialAccountId: r.id, error: null } })
          : // The post already goes to the replacement: the removed account's copy would only post it twice.
            await prisma.postTarget.deleteMany({ where: guard });
      if (counts && res.count) {
        result.moved += res.count;
        result.movedTo.push(byId.get(r.id)!.handle);
      }
    }
  }
  result.movedTo = [...new Set(result.movedTo)];

  // Drive auto-post's ticked Instagram accounts follow the same rule.
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { driveSource: true } });
  const ds = client?.driveSource as { socialAccountIds?: unknown } | null | undefined;
  if (ds && Array.isArray(ds.socialAccountIds)) {
    const ids = ds.socialAccountIds.filter((v): v is string => typeof v === "string");
    const next = rehomeIds(ids, accounts);
    if (next.join() !== ids.join()) {
      const patch = JSON.stringify({ socialAccountIds: next });
      const seen = JSON.stringify(ds.socialAccountIds);
      // Only over the list it read, so an operator's save in between is never undone.
      await prisma.$executeRaw`UPDATE "Client" SET "driveSource" = "driveSource" || ${patch}::jsonb
        WHERE "id" = ${clientId} AND jsonb_typeof("driveSource") = 'object'
          AND "driveSource"->'socialAccountIds' = ${seen}::jsonb`;
    }
  }
  return result;
}
