import { enqueue, getPrisma } from "@toreroflow/db";
import type { ZernioProvider } from "@toreroflow/publishers";

/**
 * Ask the platform whether a post it accepted actually went up.
 *
 * The provider's createPost returns an id as soon as it has taken the request.
 * Publishing happens afterwards, on the platform, and can fail for reasons the
 * request never sees: a Reel over the API's 90 second cap, media the platform
 * refuses, an account that lost its permission. None of that comes back on the
 * original call.
 *
 * Without this the app had no idea. A client's video was accepted on the 12th
 * and again on the 15th, failed inside the provider both times with "Publishing
 * failed due to max retries reached", and the calendar showed Posted with a
 * green tick each time. Three days of a client's content quietly not existing.
 *
 * Runs on a short interval because a real publish usually settles in under a
 * minute and an operator watching the calendar should see it land.
 */

const prisma = getPrisma();

/**
 * How long a post may sit unconfirmed before it is called failed.
 *
 * Generous, because the provider retries internally and a slow platform is not
 * a failed one. But bounded: a target stuck at "publishing" forever is the same
 * invisible failure in a different costume, so eventually it has to say so.
 */
const GIVE_UP_AFTER_MS = 45 * 60 * 1000;

/** Provider statuses that mean the platform finished the job. */
export const DONE = new Set(["published", "posted", "complete", "completed", "success"]);
/** Provider statuses that mean it will not happen without a human. */
export const DEAD = new Set(["failed", "error", "rejected", "cancelled", "canceled"]);

export interface ProviderEntry {
  platform: string;
  accountId: string | null;
  status: string;
  error: string | null;
  url: string | null;
}

/**
 * The provider entry describing THIS target, or undefined.
 *
 * One provider post carries every platform it was sent to and they fail
 * independently: an Instagram Reel can be refused while the TikTok and YouTube
 * copies of the same video go up fine. Picking the wrong entry marks a live
 * post failed or a failed post live, and both are worse than not knowing.
 *
 * Matched on the provider's account id first, so a brand with two accounts on
 * one platform resolves to the right row, then by platform alone for entries
 * that carry no id.
 */
export function entryFor(
  entries: readonly ProviderEntry[],
  platform: string,
  providerAccountId: string | null,
): ProviderEntry | undefined {
  const samePlatform = entries.filter((e) => e.platform === platform);
  if (samePlatform.length <= 1) return samePlatform[0];
  if (providerAccountId) {
    const exact = samePlatform.find((e) => e.accountId === providerAccountId);
    if (exact) return exact;
  }
  /*
   * Two entries on one platform and nothing to tell them apart. Deliberately
   * undefined rather than a guess: picking one at random would attach another
   * account's failure to this target, and the caller treats "unknown" as still
   * in flight, which resolves itself on a later pass or times out honestly.
   */
  return undefined;
}

export type Outcome = "posted" | "failed" | "waiting";

/** What a provider status means for a target, with unknown treated as waiting. */
export function outcomeOf(state: string | null | undefined): Outcome {
  const s = (state ?? "").toLowerCase();
  if (DONE.has(s)) return "posted";
  if (DEAD.has(s)) return "failed";
  return "waiting";
}

export async function confirmPublishing(zernio: ZernioProvider | null): Promise<void> {
  if (!zernio) return;

  const waiting = await prisma.postTarget.findMany({
    where: { status: "publishing", remotePostId: { not: null } },
    include: { socialAccount: { select: { providerAccountId: true, platform: true } } },
  });
  if (!waiting.length) return;

  for (const target of waiting) {
    try {
      const result = await zernio.postStatus(target.remotePostId!);

      /*
       * The entry for THIS target, not the post's overall status.
       *
       * One provider post carries every platform it was sent to, and they fail
       * independently: an Instagram Reel can be refused while the TikTok and
       * YouTube copies of the same video go up fine. Reading the post-level
       * status would mark all three failed, or all three posted, and both are
       * lies about two of them.
       *
       * Matched on the provider's account id where the entry carries one, so a
       * brand with two accounts on one platform resolves to the right row.
       */
      const mine = entryFor(
        result.platforms,
        target.platform,
        target.socialAccount.providerAccountId,
      );

      /*
       * No entry for this target means the post-level status is all there is,
       * and that is only safe to act on when the post went to one platform.
       * On a cross-post it describes somebody else's outcome as much as this
       * one, so it waits instead.
       */
      const state = mine ? mine.status : result.platforms.length <= 1 ? result.status : "unknown";
      const outcome = outcomeOf(state);

      if (outcome === "posted") {
        await prisma.postTarget.update({
          where: { id: target.id },
          data: {
            status: "posted",
            publishedAt: new Date(),
            error: null,
            ...(mine?.url ? { remoteUrl: mine.url } : {}),
          },
        });
        const siblings = await prisma.postTarget.findMany({ where: { postId: target.postId } });
        if (siblings.every((s) => s.status === "posted")) {
          await prisma.post.update({ where: { id: target.postId }, data: { status: "posted" } });
        }
        console.log(`[worker] target ${target.id} confirmed published (${target.platform})`);
        continue;
      }

      if (outcome === "failed") {
        const why = mine?.error ?? `the platform reported "${state}"`;

        /*
         * The extra pass.
         *
         * A reel that Instagram would not finish is republished as a feed post,
         * once. Instagram takes an hour of video that way, so the choice is
         * between a video on the profile without the Reels tab and no video at
         * all, and the second is not a real option for a client who was
         * promised a post.
         *
         * The reel is always attempted first, because the Reels tab is the
         * whole reason to prefer one. This only runs after the platform has
         * actually said no, so nothing is given up on a guess, and the flag
         * makes it strictly once: a feed post that fails is simply failed.
         */
        const opts = (target.options as Record<string, unknown> | null) ?? {};
        const alreadyRetried = opts.instagramFeedPost === true;
        if (target.platform === "instagram" && !alreadyRetried) {
          await prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "scheduled",
              remotePostId: null,
              error: `Instagram would not publish this as a reel (${why}). Retrying as a feed post.`,
              options: { ...opts, instagramFeedPost: true } as never,
            },
          });
          await enqueue("publish", { targetId: target.id }, { key: target.id });
          console.log(`[worker] target ${target.id} reel refused, retrying as a feed post`);
          continue;
        }

        await prisma.postTarget.update({
          where: { id: target.id },
          data: { status: "failed", error: why.slice(0, 500) },
        });
        await prisma.post.update({ where: { id: target.postId }, data: { status: "failed" } });
        console.error(`[worker] target ${target.id} FAILED at the platform: ${why}`);
        continue;
      }

      // Still in flight. Left alone until it settles or runs out of patience.
      const since = target.publishedAt ?? target.scheduledAt ?? target.updatedAt;
      if (since && Date.now() - since.getTime() > GIVE_UP_AFTER_MS) {
        await prisma.postTarget.update({
          where: { id: target.id },
          data: {
            status: "failed",
            error: `The platform never confirmed this post. It was last reported as "${state}".`,
          },
        });
        await prisma.post.update({ where: { id: target.postId }, data: { status: "failed" } });
        console.error(`[worker] target ${target.id} gave up waiting (${state})`);
      }
    } catch (error) {
      // A failed lookup is not a failed post. Left as it is and tried again on
      // the next pass, because calling a live post failed because the provider
      // was briefly unreachable would be its own kind of wrong.
      console.error(`[worker] could not confirm target ${target.id}:`, error);
    }
  }
}
