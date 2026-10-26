/**
 * What a bot token is allowed to do: upload a video, write its copy, set its
 * cover, schedule it, and read just enough to do those things.
 *
 * The operator JWT can also read financials, delete media, and message
 * clients from the inbox. A bot exists to automate one workflow, and an
 * automation holding more power than its job needs is not a convenience, it
 * is blast radius: one bad prompt or leaked token and the damage is bounded
 * by this list instead of by everything the app can do.
 *
 * A whitelist rather than a blocklist, because routes get added weekly and a
 * blocklist silently grants each new one to every bot that exists. A new
 * route is closed to bots until someone decides otherwise here.
 */

interface Rule {
  method: string;
  /** Regex over the path (no query string). Anchored on both ends. */
  path: RegExp;
}

const ID = "[A-Za-z0-9_-]+";

const ALLOW: Rule[] = [
  // Who am I, and which clients and accounts exist: the ids every other call
  // needs. Read-only.
  { method: "GET", path: new RegExp(`^/auth/me$`) },
  { method: "GET", path: new RegExp(`^/clients$`) },
  // Which pipeline cards are ready, which client each belongs to, and that
  // client's SOP. Read-only; editing SOPs and label routing stays human.
  { method: "GET", path: new RegExp(`^/trello/ready$`) },
  { method: "GET", path: new RegExp(`^/clients/label-map$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/sop$`) },

  // The workflow itself: upload, poll processing, write copy, schedule.
  { method: "POST", path: new RegExp(`^/clients/${ID}/media$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/media$`) },
  { method: "GET", path: new RegExp(`^/media/${ID}$`) },
  { method: "PATCH", path: new RegExp(`^/media/${ID}/draft$`) },
  // Short-form or long-form ("short" | "long"): which quota it spends and
  // which flow schedules it. Also settable at upload with ?format=.
  { method: "PATCH", path: new RegExp(`^/media/${ID}/format$`) },
  { method: "POST", path: new RegExp(`^/media/${ID}/schedule$`) },
  // Long-form Instagram pre-check: file size, fit, publishing allowance. Read-only.
  { method: "GET", path: new RegExp(`^/media/${ID}/instagram-fit$`) },
  // Set the cover: pick a frame or upload an image. The routes keep their own
  // checks (JPEG/PNG only, size cap, asset must be in the token's agency).
  { method: "PATCH", path: new RegExp(`^/media/${ID}/cover$`) },
  { method: "POST", path: new RegExp(`^/media/${ID}/cover-image$`) },

  // Its own scheduled posts, so it can confirm what it just did. Read-only:
  // rescheduling, retrying and deleting stay human actions.
  { method: "GET", path: new RegExp(`^/clients/${ID}/posts$`) },

  // Close the loop on the pipeline card it just scheduled: move it from
  // Ready for posting to "Approved by Client/ uploaded". The route only moves
  // a Ready card whose label maps to that client, nothing else on the board.
  { method: "POST", path: new RegExp(`^/trello/cards/${ID}/uploaded$`) },
];

/**
 * Bots named here get the operator's full access: read, write, edit, publish,
 * comments included. Per bot, never "every bot": Tyrone opened the whole app
 * to Polly (Oct 26, 2026) and to nobody else, so a token minted without her
 * name, or for any other bot, stays on the whitelist below. BOT_FULL_ACCESS
 * overrides the list (comma separated; empty turns it off).
 */
export function fullAccessBots(envs: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (envs.BOT_FULL_ACCESS ?? "polly")
      .split(",")
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isFullAccessBot(
  bot: string | null | undefined,
  envs: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(bot) && fullAccessBots(envs).has(bot!.toLowerCase());
}

/**
 * Comments: reading is open to every bot, like the rest of the read-only
 * workflow. Reply, hide and delete need the operator or a full-access bot,
 * which the route checks again so the rule lives next to the action.
 */
ALLOW.push(
  { method: "GET", path: new RegExp(`^/clients/${ID}/comments$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/comments/${ID}$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/instagram-limit$`) },
);

/** True when a bot-role token may make this request. */
export function botAllowed(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return ALLOW.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}
