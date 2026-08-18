import { promises as fs } from "node:fs";
import path from "node:path";
import { decryptSecret, getPrisma } from "@toreroflow/db";
import {
  accessTokenFrom,
  GoogleAuthError,
  setThumbnail,
  videoIdFromUrl,
} from "@toreroflow/publishers";
import { env } from "./env";

/**
 * Thumbnail A/B testing, run by us because nobody rents it out.
 *
 * YouTube's Test & Compare has no API, and impressions with their
 * click-through rate never made it into the public Analytics API at all;
 * they exist only inside Studio's own screens. So the app runs the
 * experiment with the two levers it truly holds: thumbnails.set to swap the
 * image on a schedule, and its own daily view capture (ExternalVideoMetric,
 * one row per video per day since July) to read the effect.
 *
 * That makes the measurement views per day, not CTR, and the difference is
 * stated wherever the result is shown: views/day folds impressions volume in
 * with click-through, so a variant that ran during a good week can beat a
 * better image. Same video, adjacent windows, one variable moved; it is the
 * honest test available, not the perfect one.
 *
 * ponytail: one A-then-B pass. Alternating A/B/A/B over shorter windows
 * would average out time-of-month luck; add if a test ever reads wrong.
 */

const prisma = getPrisma();

/** Tests only make sense on videos still young enough to move. */
const SWEEP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AbTest {
  periodDays: number;
  startedAt: string;
  variants: { a: { key: string }; b: { key: string } };
  applied: "a" | "b" | null;
  state: "running" | "done" | "cancelled" | "error";
  note?: string;
  result?: AbResult;
}

export interface AbResult {
  aPerDay: number | null;
  bPerDay: number | null;
  winner: "a" | "b" | null;
  note: string;
}

/** Which variant should be live at `now`, or "finish" when both have run. */
export function dueSlot(test: Pick<AbTest, "periodDays" | "startedAt">, now: Date): "a" | "b" | "finish" {
  const elapsed = now.getTime() - new Date(test.startedAt).getTime();
  const index = Math.floor(elapsed / (test.periodDays * DAY_MS));
  return index <= 0 ? "a" : index === 1 ? "b" : "finish";
}

/**
 * Views per day across a window of cumulative daily captures.
 *
 * The rows are lifetime totals, one per day, so the rate is the delta between
 * the last and first capture inside the window over the days between them.
 * Fewer than two captures is no measurement, and null says so; a zero here
 * would read as "the thumbnail killed the video" when the truth is "the
 * capture missed a day".
 */
export function viewsPerDay(
  rows: ReadonlyArray<{ capturedOn: Date; views: number }>,
  from: Date,
  to: Date,
): number | null {
  const inWindow = rows
    .filter((r) => r.capturedOn >= from && r.capturedOn < to)
    .sort((a, b) => a.capturedOn.getTime() - b.capturedOn.getTime());
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  const days = (last.capturedOn.getTime() - first.capturedOn.getTime()) / DAY_MS;
  if (days < 1) return null;
  return Math.round(((last.views - first.views) / days) * 10) / 10;
}

/** The verdict once both windows have run. Null rates never produce a winner. */
export function abResult(aPerDay: number | null, bPerDay: number | null): AbResult {
  if (aPerDay === null || bPerDay === null) {
    return {
      aPerDay,
      bPerDay,
      winner: null,
      note: "Not enough daily captures landed in one of the windows, so there is no honest verdict.",
    };
  }
  if (aPerDay === bPerDay) {
    return { aPerDay, bPerDay, winner: null, note: "Dead even. Keep whichever image the client prefers." };
  }
  const winner = bPerDay > aPerDay ? "b" : "a";
  return {
    aPerDay,
    bPerDay,
    winner,
    note:
      `Variant ${winner.toUpperCase()} averaged ${winner === "b" ? bPerDay : aPerDay} views/day against ` +
      `${winner === "b" ? aPerDay : bPerDay}. Views/day folds impressions volume in with click-through, ` +
      "so treat a narrow margin as noise.",
  };
}

/** The stored test on a target's options, or null when absent or malformed. */
export function abTestFrom(options: unknown): AbTest | null {
  const yt = (options as { youtube?: Record<string, unknown> } | null)?.youtube;
  const t = yt?.abTest as AbTest | undefined;
  if (!t || typeof t !== "object") return null;
  if (typeof t.periodDays !== "number" || typeof t.startedAt !== "string") return null;
  if (!t.variants?.a?.key || !t.variants?.b?.key) return null;
  return t;
}

export interface AbSweepOutcome {
  targetId: string;
  action: "rotated" | "finished" | "waiting" | "skipped" | "error";
  detail?: string;
}

export async function sweepThumbnailTests(): Promise<AbSweepOutcome[]> {
  const targets = await prisma.postTarget.findMany({
    where: {
      platform: "youtube",
      status: "posted",
      publishedAt: { gt: new Date(Date.now() - SWEEP_WINDOW_MS) },
    },
    select: { id: true, options: true, remoteUrl: true, socialAccountId: true },
  });

  const outcomes: AbSweepOutcome[] = [];
  for (const target of targets) {
    const test = abTestFrom(target.options);
    if (!test || test.state !== "running") continue;

    const options = (target.options as Record<string, unknown> | null) ?? {};
    const yt = (options.youtube as Record<string, unknown> | undefined) ?? {};
    const writeTest = async (patch: Partial<AbTest>) => {
      await prisma.postTarget.update({
        where: { id: target.id },
        data: {
          options: { ...options, youtube: { ...yt, abTest: { ...test, ...patch } } } as never,
        },
      });
    };

    try {
      const now = new Date();
      const slot = dueSlot(test, now);
      const videoId = videoIdFromUrl(target.remoteUrl);
      if (!videoId) {
        outcomes.push({ targetId: target.id, action: "waiting", detail: "no video id yet" });
        continue;
      }
      const connection = await prisma.platformConnection.findFirst({
        where: { socialAccountId: target.socialAccountId, platform: "youtube", status: "active" },
        select: { refreshTokenEnc: true },
      });
      if (!connection || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        outcomes.push({ targetId: target.id, action: "waiting", detail: "no direct connection" });
        continue;
      }
      const token = () =>
        accessTokenFrom(
          { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
          decryptSecret(connection.refreshTokenEnc),
        );
      const imageFor = async (key: string) => {
        const body = await fs.readFile(path.join(env.STORAGE_DIR, key));
        const type = key.toLowerCase().endsWith(".png") ? ("image/png" as const) : ("image/jpeg" as const);
        return { body, type };
      };

      if (slot === "finish") {
        const start = new Date(test.startedAt);
        const mid = new Date(start.getTime() + test.periodDays * DAY_MS);
        const end = new Date(start.getTime() + 2 * test.periodDays * DAY_MS);
        const video = await prisma.externalVideo.findFirst({
          where: { socialAccountId: target.socialAccountId, platformVideoId: videoId },
          select: { metrics: { select: { capturedOn: true, views: true } } },
        });
        const rows = video?.metrics ?? [];
        const result = abResult(viewsPerDay(rows, start, mid), viewsPerDay(rows, mid, end));

        // The winner's image ends up live. B is already up; only a win by A
        // needs one last swap, and a verdictless test keeps what is showing.
        if (result.winner && result.winner !== test.applied) {
          const img = await imageFor(test.variants[result.winner].key);
          await setThumbnail(await token(), videoId, img.body, img.type);
        }
        await writeTest({ state: "done", applied: result.winner ?? test.applied, result });
        console.log(`[worker] thumbnail test finished for target ${target.id}: ${result.note}`);
        outcomes.push({ targetId: target.id, action: "finished", detail: result.note });
        continue;
      }

      if (slot !== test.applied) {
        const img = await imageFor(test.variants[slot].key);
        await setThumbnail(await token(), videoId, img.body, img.type);
        await writeTest({ applied: slot });
        console.log(`[worker] thumbnail test rotated target ${target.id} to variant ${slot}`);
        outcomes.push({ targetId: target.id, action: "rotated", detail: slot });
      } else {
        outcomes.push({ targetId: target.id, action: "waiting" });
      }
    } catch (error) {
      if (error instanceof GoogleAuthError && error.revoked) {
        await writeTest({
          state: "error",
          note: "The channel's connection cannot set thumbnails. Send a fresh connect link from Settings; the test stopped where it was.",
        });
        outcomes.push({ targetId: target.id, action: "error", detail: "needs re-consent" });
        continue;
      }
      // Weather: file briefly unreadable, quota, network. The next daily pass
      // retries; a rotation landing a day late stretches a window rather than
      // breaking the test.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[worker] thumbnail test hiccup for target ${target.id} (will retry): ${detail}`);
      outcomes.push({ targetId: target.id, action: "error", detail });
    }
  }
  return outcomes;
}
