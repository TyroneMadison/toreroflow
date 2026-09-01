/**
 * What a bot token is allowed to do: upload a video, write its copy, schedule
 * it, and read just enough to do those three things.
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

  // The workflow itself: upload, poll processing, write copy, schedule.
  { method: "POST", path: new RegExp(`^/clients/${ID}/media$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/media$`) },
  { method: "GET", path: new RegExp(`^/media/${ID}$`) },
  { method: "PATCH", path: new RegExp(`^/media/${ID}/draft$`) },
  { method: "POST", path: new RegExp(`^/media/${ID}/schedule$`) },

  // Its own scheduled posts, so it can confirm what it just did. Read-only:
  // rescheduling, retrying and deleting stay human actions.
  { method: "GET", path: new RegExp(`^/clients/${ID}/posts$`) },
];

/** True when a bot-role token may make this request. */
export function botAllowed(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return ALLOW.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}
