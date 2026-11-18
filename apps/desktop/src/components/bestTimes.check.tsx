/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * bestSlot picks the hour with the top average views and returns its next
 * occurrence at least 10 minutes out.
 */
import { bestSlot } from "./BestTimes";
import type { ClientPost } from "../lib/api";

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: got ${String(a)}, want ${String(b)}`);
}
const at = (h: number, views: number) =>
  ({ publishedAt: new Date(2026, 0, 5, h, 30).toISOString(), byPlatform: [{ platform: "tiktok", views }] }) as unknown as ClientPost;

eq(bestSlot([]), null, "no history gives no slot");
eq(bestSlot([at(9, 0)]), null, "posts without views give no slot");

const posts = [at(9, 100), at(18, 900), at(18, 700), at(13, 400)];
const morning = new Date(2026, 10, 18, 8, 0);
const s1 = bestSlot(posts, morning)!;
eq(s1.getHours(), 18, "the hour with the top average wins");
eq(s1.getDate(), 18, "later today when the hour is still ahead");
eq(s1.getMinutes(), 0, "on the hour");

const close = new Date(2026, 10, 18, 17, 55);
eq(bestSlot(posts, close)!.getDate(), 19, "under 10 minutes out rolls to tomorrow");

console.log("bestTimes: all checks passed");
