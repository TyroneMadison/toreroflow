import type { FastifyBaseLogger } from "fastify";
import { PLATFORMS, type Platform, fieldsToUpdate, mergeHandles, readWelcomeReply, type WelcomeReply } from "@toreroflow/core";
import { getPrisma, enqueue } from "@toreroflow/db";
import { ZernioProvider } from "@toreroflow/publishers";
import { NetlifyPublisher } from "./reports/netlify";
import { env } from "./env";

/**
 * The other half of the welcome link: what the client does on their own
 * page has to reach the app without anyone pressing a button.
 *
 * A client connects an account on the provider's hosted page at 9pm, or
 * sends the form from their phone at lunch. The operator is not in the app
 * at that moment, so the "sync" and "check replies" buttons - which run
 * exactly this code - cannot be the only way those arrive. This sweep runs
 * the same two imports on a timer; the buttons remain as the impatient path.
 */

/** Where the form lives. The site is found by this domain, not by an id. */
export const SITE_DOMAIN = "torerone.com";
export const WELCOME_FORM = "client-welcome";

/**
 * Pull the accounts connected on the provider's hosted page into rows the
 * app can schedule against. Exactly what the sync button does.
 *
 * Returns how many connected accounts the provider holds (`seen`) and how
 * many were new to us (`created`) - the sweep only reacts to `created`,
 * because `seen` is nonzero forever once the first account connects.
 */
export async function importProviderAccounts(
  zernio: ZernioProvider,
  client: { id: string; providerProfileId: string },
): Promise<{ seen: number; created: number }> {
  const prisma = getPrisma();
  const remote = await zernio.accountsForProfile(client.providerProfileId);
  const valid = remote.filter((a) => (PLATFORMS as readonly string[]).includes(a.platform));
  let created = 0;
  for (const a of valid) {
    const platform = a.platform as Platform;
    const profileData = a.metadata?.profileData;
    const handle = profileData?.username ?? a.username ?? a.displayName ?? a.name ?? a.platform;
    const avatarUrl = profileData?.profilePicture ?? null;
    const displayName = a.displayName ?? profileData?.displayName ?? null;
    /*
     * Match on the provider's account id, not on the platform. Matching
     * by platform meant a second Facebook page silently overwrote the
     * first: the sync found "the client's facebook row" and updated it,
     * and the brand could never hold two pages at once. The platform
     * fallback only catches legacy rows connected before provider ids
     * were stored, and only when they have no id to disagree with.
     */
    const existing =
      (await prisma.socialAccount.findFirst({
        where: { clientId: client.id, providerAccountId: a._id, deletedAt: null },
      })) ??
      (await prisma.socialAccount.findFirst({
        where: {
          clientId: client.id,
          platform,
          providerAccountId: null,
          deletedAt: null,
          // Reminder accounts also have no provider id, and are not
          // legacy rows waiting to be claimed by an import.
          NOT: { tokensEncrypted: "reminder" },
        },
      }));
    const account = existing
      ? await prisma.socialAccount.update({
          where: { id: existing.id },
          data: {
            handle,
            status: "connected",
            providerAccountId: a._id,
            avatarUrl,
            displayName,
            connectedAt: new Date(),
          },
        })
      : await prisma.socialAccount.create({
          data: {
            clientId: client.id,
            platform,
            handle,
            status: "connected",
            providerAccountId: a._id,
            avatarUrl,
            displayName,
            // Tokens stay with the provider; this marks custody, not a secret.
            tokensEncrypted: "provider:zernio",
          },
        });
    if (!existing) created += 1;
    // Followers are known right now; seed today's snapshot immediately.
    if (typeof a.followersCount === "number") {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const snap = await prisma.metricSnapshot.findFirst({
        where: { socialAccountId: account.id, capturedAt: { gte: dayStart } },
      });
      if (snap) {
        await prisma.metricSnapshot.update({
          where: { id: snap.id },
          data: { followers: a.followersCount },
        });
      } else {
        await prisma.metricSnapshot.create({
          data: {
            socialAccountId: account.id,
            capturedAt: new Date(),
            followers: a.followersCount,
          },
        });
      }
    }
  }
  return { seen: valid.length, created };
}

export interface WelcomeApplyResult {
  checked: number;
  applied: Array<{ client: string; filled: string[]; handles: number }>;
  unmatched: number;
  alreadyApplied: number;
}

/**
 * Pull replies and apply them. Exactly what the check-replies button does.
 *
 * An answer wins. The client is the authority on their own name, number and
 * handles, so what they write replaces what is on file: that is the point of
 * sending the link to a brand that already exists. A box they left empty is
 * not an answer and clears nothing, because no field on the form is required
 * and a half finished reply is the normal case.
 *
 * `agencyId` scopes a button press to the operator's own brands; the sweep
 * passes null and matches replies across the whole database, which the
 * unique onboarding token makes safe.
 */
export async function applyWelcomeReplies(
  submissions: WelcomeReply[],
  agencyId: string | null,
): Promise<WelcomeApplyResult> {
  const prisma = getPrisma();
  const applied: WelcomeApplyResult["applied"] = [];
  let unmatched = 0;
  /** Replies seen before. Counted so a quiet check can say why it was quiet. */
  let alreadyApplied = 0;

  for (const submission of submissions) {
    const parsed = readWelcomeReply(submission);
    if (!parsed.token) {
      unmatched += 1;
      continue;
    }
    const client = await prisma.client.findFirst({
      where: {
        onboardingToken: parsed.token,
        ...(agencyId ? { agencyId } : {}),
        deletedAt: null,
      },
      select: { id: true, name: true, handles: true, welcomeRepliesApplied: true },
    });
    if (!client) {
      unmatched += 1;
      continue;
    }

    /*
     * Applied once, ever.
     *
     * Every check reads the whole list of replies back from the host, so
     * without this the same answers would be written again on every pass.
     * That is not harmless now that an answer wins: a detail corrected by
     * hand afterwards would be silently reverted to what the client typed
     * weeks earlier.
     */
    if (client.welcomeRepliesApplied.includes(submission.id)) {
      alreadyApplied += 1;
      continue;
    }

    const fill = fieldsToUpdate(parsed.patch);

    /*
     * Their handles are merged, not replaced. Answering only the YouTube box
     * must not erase the Instagram handle they gave last time.
     *
     * Stored apart from connected accounts on purpose: a typed handle cannot
     * post anything, and writing one in as an account would put a row on
     * screen that looks connected and is not. Connecting is the separate tap
     * that goes to the provider.
     */
    const handles = parsed.handles.length
      ? mergeHandles(client.handles as Record<string, string> | null, parsed.handles)
      : undefined;

    await prisma.client.update({
      where: { id: client.id },
      data: {
        ...fill,
        ...(handles ? { handles } : {}),
        onboardedAt: new Date(),
        welcomeRepliesApplied: { push: submission.id },
      },
    });

    /*
     * What they wrote is kept as a note, not turned into accounts.
     *
     * A handle they typed is not a connected account: connected accounts
     * only ever come back from the publishing provider, and writing one here
     * would put a row on screen that cannot post anything. Nor are these
     * inspiration accounts, which mean the opposite thing, someone whose
     * content they want theirs to resemble.
     *
     * So it lands where free text about a brand belongs, ready for the
     * operator to read and act on, and easy to delete.
     */
    const body = [
      ...parsed.handles.map((h) => `${h.platform}: @${h.handle}`),
      ...(parsed.notes ? ["", parsed.notes] : []),
    ].join("\n");
    if (body.trim()) {
      await prisma.knowledgeNote.create({
        data: {
          clientId: client.id,
          title: `From their welcome form, ${new Date(submission.createdAt || Date.now()).toLocaleDateString("en-US")}`,
          body,
        },
      });
    }

    applied.push({
      // The name they gave, where they gave one, so the operator reads what
      // the brand is called now rather than what it used to be.
      client: fill.name ?? client.name,
      filled: Object.keys(fill),
      handles: parsed.handles.length,
    });
  }

  return { checked: submissions.length, applied, unmatched, alreadyApplied };
}

/** The site serving torerone.com, found by its domain so no id is stored. */
export async function welcomeSiteId(net: NetlifyPublisher): Promise<string | null> {
  const sites = await net.listSites();
  return sites.find((s) => s.custom_domain === SITE_DOMAIN)?.id ?? null;
}

const SWEEP_MS = 10 * 60 * 1000;

/**
 * Both imports on a timer, so a client's evening reaches the operator's
 * morning without anyone in between. Each half is skipped, not failed, when
 * its credential is absent, and one bad pass never stops the next.
 */
export function startOnboardingSweep(log: FastifyBaseLogger): void {
  const prisma = getPrisma();

  const tick = async () => {
    if (env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY) {
      const zernio = new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY);
      let created = 0;
      const clients = await prisma.client.findMany({
        where: { deletedAt: null, providerProfileId: { not: null } },
        select: { id: true, name: true, providerProfileId: true },
      });
      for (const client of clients) {
        try {
          const result = await importProviderAccounts(zernio, {
            id: client.id,
            providerProfileId: client.providerProfileId!,
          });
          if (result.created > 0) {
            created += result.created;
            log.info(
              { client: client.name, created: result.created },
              "welcome sweep imported newly connected accounts",
            );
          }
        } catch (err) {
          log.warn({ err, client: client.name }, "welcome sweep could not sync accounts");
        }
      }
      // Backfill history from the provider's already-synced posts right away.
      if (created > 0) await enqueue("analytics", {});
    }

    if (env.NETLIFY_AUTH_TOKEN) {
      try {
        const net = new NetlifyPublisher(env.NETLIFY_AUTH_TOKEN);
        const siteId = await welcomeSiteId(net);
        if (siteId) {
          const submissions = await net.formSubmissions(siteId, WELCOME_FORM);
          const result = await applyWelcomeReplies(submissions, null);
          if (result.applied.length) {
            log.info({ applied: result.applied }, "welcome sweep applied form replies");
          }
        }
      } catch (err) {
        log.warn({ err }, "welcome sweep could not read form replies");
      }
    }
  };

  // Shortly after boot, then steady. Never overlapping: a pass at this scale
  // finishes in seconds, and both halves are idempotent anyway.
  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), SWEEP_MS);
}
