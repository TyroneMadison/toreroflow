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

/** True when a bot-role token may make this request. */
export function botAllowed(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return ALLOW.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}
