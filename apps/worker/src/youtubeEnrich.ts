import { promises as fs } from "node:fs";
import path from "node:path";
import { decryptSecret, getPrisma } from "@toreroflow/db";
import {
  accessTokenFrom,
  applyVideoMetadata,
  enrichFieldsFrom,
  GoogleAuthError,
  uploadCaption,
  videoIdFromUrl,
} from "@toreroflow/publishers";
import { env } from "./env";

/**
 * Lays the long-form wizard's stored metadata onto a video after it publishes.
 *
 * Runs from two places: confirmPublishing calls it the moment a YouTube
 * target flips to posted (the normal path, minutes after publish), and a
 * sweep retries stragglers, because the enrichment needs a working OAuth
 * credential at exactly the moment the post confirms and "the client had not
 * clicked the consent link yet that morning" should mean applied-later, not
 * never-applied.
 *
 * State lives inside the target's own options.youtube:
 *   enrichedAt   - done; carries the ISO time and is never retried.
 *   enrichError  - terminal; a human has to act (usually: reconnect the
 *                  channel with the new permission). Never retried by the
 *                  sweep, because retrying a consent problem just relogs it.
 *   neither      - pending; the sweep keeps trying inside its window.
 *
 * Never throws to its callers. The post IS published; nothing that happens in
 * here is allowed to make a posted video look failed.
 */

const prisma = getPrisma();

/** How far back the sweep looks. Older than this, the moment has passed. */
const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface EnrichOutcome {
  targetId: string;
  outcome: "applied" | "nothing" | "pending" | "error";
  detail?: string;
}

export async function enrichYouTubeTarget(
  targetId: string,
  knownVideoId?: string | null,
): Promise<EnrichOutcome> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      platform: true,
      status: true,
      options: true,
      remoteUrl: true,
      socialAccountId: true,
    },
  });
  if (!target || target.platform !== "youtube" || target.status !== "posted") {
    return { targetId, outcome: "nothing" };
  }

  const options = (target.options as Record<string, unknown> | null) ?? {};
  const yt = (options.youtube as Record<string, unknown> | undefined) ?? {};
  if (yt.enrichedAt || yt.enrichError) return { targetId, outcome: "nothing" };

  const fields = enrichFieldsFrom(options);
  /*
   * The subtitle track rides beside the metadata rather than inside it: it is
   * its own API (captions.insert), its own file on disk, and a video can have
   * either without the other.
   */
  const captions =
    yt.captions &&
    typeof yt.captions === "object" &&
    typeof (yt.captions as Record<string, unknown>).key === "string" &&
    typeof (yt.captions as Record<string, unknown>).language === "string"
      ? (yt.captions as { key: string; language: string; name?: string })
      : null;
  if (!fields && !captions) return { targetId, outcome: "nothing" };

  const writeState = async (patch: Record<string, unknown>) => {
    await prisma.postTarget.update({
      where: { id: target.id },
      data: { options: { ...options, youtube: { ...yt, ...patch } } as never },
    });
  };

  const videoId = knownVideoId ?? videoIdFromUrl(target.remoteUrl);
  if (!videoId) {
    // No id means the confirm poll never learned one, which on YouTube means
    // something upstream is already wrong. Pending, not terminal: the sweep
    // runs after the confirm poll has had more chances to fill remoteUrl in.
    return { targetId, outcome: "pending", detail: "no video id yet" };
  }

  const connection = await prisma.platformConnection.findFirst({
    where: { socialAccountId: target.socialAccountId, platform: "youtube", status: "active" },
    select: { refreshTokenEnc: true },
  });
  if (!connection) {
    // Also pending: the operator may send the consent link this week. The
    // sweep window is what stops this from being retried forever.
    return { targetId, outcome: "pending", detail: "no direct connection" };
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return { targetId, outcome: "pending", detail: "google credentials not configured" };
  }

  try {
    const accessToken = await accessTokenFrom(
      { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      decryptSecret(connection.refreshTokenEnc),
    );
    const parts = fields ? await applyVideoMetadata(accessToken, videoId, fields) : [];
    if (captions) {
      /*
       * A missing file is terminal, not weather: nothing regrows it, and
       * retrying nightly for a fortnight would log the same absence fourteen
       * times. The metadata half still applied, so the state says exactly
       * which half needs a human.
       */
      let body: Uint8Array;
      try {
        body = await fs.readFile(path.join(env.STORAGE_DIR, captions.key));
      } catch {
        await writeState({
          enrichedAt: new Date().toISOString(),
          enrichApplied: parts,
          enrichError: `The subtitle file (${captions.language}) is gone from storage; upload it by hand in Studio.`,
        });
        return { targetId, outcome: "error", detail: "caption file missing" };
      }
      await uploadCaption(
        accessToken,
        videoId,
        captions.language,
        captions.name ?? captions.language,
        body,
      );
      parts.push("captions");
    }
    await writeState({ enrichedAt: new Date().toISOString(), enrichApplied: parts });
    console.log(`[worker] enriched youtube target ${target.id} (${parts.join(", ") || "nothing to change"})`);
    return { targetId, outcome: "applied", detail: parts.join(",") };
  } catch (error) {
    if (error instanceof GoogleAuthError && error.revoked) {
      /*
       * A consent problem, and the most likely one is benign: the channel
       * authorized before the write scope existed. Terminal on this target
       * (retrying relogs the same refusal), with words the operator can act
       * on. The next video enriches fine once the channel reconnects.
       */
      const detail =
        "The channel's connection predates the app's publish permission. " +
        "Send a fresh connect link from Settings and future videos enrich themselves; " +
        "this one's tags and settings are two clicks away in Studio.";
      await writeState({ enrichError: detail });
      console.error(`[worker] youtube enrich needs re-consent for target ${target.id}`);
      return { targetId, outcome: "error", detail };
    }
    // Anything else is weather: quota, network, a Google hiccup. Pending, so
    // the sweep tries again on its own clock.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[worker] youtube enrich failed for target ${target.id} (will retry): ${detail}`);
    return { targetId, outcome: "pending", detail };
  }
}

/**
 * Retry every posted YouTube target still waiting for its metadata.
 *
 * The window is a fortnight: past that, an operator who cared has done it in
 * Studio and an operator who did not is not waiting on a robot to care more.
 */
export async function sweepYouTubeEnrichment(): Promise<EnrichOutcome[]> {
  const targets = await prisma.postTarget.findMany({
    where: {
      platform: "youtube",
      status: "posted",
      publishedAt: { gt: new Date(Date.now() - SWEEP_WINDOW_MS) },
    },
    select: { id: true },
  });
  const results: EnrichOutcome[] = [];
  for (const t of targets) {
    const r = await enrichYouTubeTarget(t.id);
    if (r.outcome !== "nothing") results.push(r);
  }
  return results;
}
