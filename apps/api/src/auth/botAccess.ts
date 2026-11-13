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

import { getPrisma } from "@toreroflow/db";
import { POLLY, ScopeSchema, type BotIdentity } from "@toreroflow/contracts";

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
  // Read-only: whether a brand's uploads are paused. Pausing stays with the operator.
  { method: "GET", path: new RegExp(`^/brands/${ID}/pause$`) },

  // Close the loop on the pipeline card it just scheduled: move it from
  // Ready for posting to "Approved by Client/ uploaded". The route only moves
  // a Ready card whose label maps to that client, nothing else on the board.
  { method: "POST", path: new RegExp(`^/trello/cards/${ID}/uploaded$`) },
];

/**
 * A bot's identity: its BotIdentity row when the agency has one, else the
 * default. Polly's default is the contracts POLLY (fullAccess: read, write,
 * edit, publish, comments included; Tyrone opened the whole app to her on
 * Oct 26, 2026). Every other bot defaults to fullAccess false and no scopes,
 * so it stays on the whitelist below exactly as before. A missing table
 * (migration not deployed yet) or a database error falls back to the default.
 */
export function defaultBotIdentity(name: string | null | undefined): BotIdentity {
  const n = (name ?? "").trim().toLowerCase();
  return n === POLLY.name ? POLLY : { name: n, fullAccess: false, scopes: [] };
}

export async function resolveBotIdentity(
  agencyId: string,
  name: string | null | undefined,
): Promise<BotIdentity> {
  const fallback = defaultBotIdentity(name);
  if (!fallback.name) return fallback;
  try {
    const row = await getPrisma().botIdentity.findUnique({
      where: { agencyId_name: { agencyId, name: fallback.name } },
      select: { fullAccess: true, scopes: true },
    });
    if (!row) return fallback;
    const scopes = row.scopes.flatMap((s) => {
      const parsed = ScopeSchema.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    });
    return { name: fallback.name, fullAccess: row.fullAccess, scopes };
  } catch {
    return fallback;
  }
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

/**
 * Templates (W5): reaching the route is open, the route then checks the
 * bot's templates:read or templates:apply scope, which no bot has unless its
 * BotIdentity grants it. Create, edit and delete are not listed: full access only.
 */
ALLOW.push(
  { method: "GET", path: new RegExp(`^/templates$`) },
  { method: "GET", path: new RegExp(`^/templates/cadence$`) },
  { method: "POST", path: new RegExp(`^/templates/${ID}/apply$`) },
);

/**
 * Clip jobs (Phase 8, K5): a bot can start a job from a file, an upload or
 * a Drive link, follow it, read and shortlist candidates, open them and
 * batch-render. Deleting a job, recipes and clip settings stay operator-only.
 */
ALLOW.push(
  { method: "POST", path: new RegExp(`^/clients/${ID}/clip-jobs$`) },
  { method: "POST", path: new RegExp(`^/clients/${ID}/clip-jobs/from-asset$`) },
  { method: "POST", path: new RegExp(`^/clients/${ID}/clip-jobs/from-drive$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/clip-jobs$`) },
  { method: "GET", path: new RegExp(`^/clip-jobs/${ID}$`) },
  { method: "POST", path: new RegExp(`^/clip-jobs/${ID}/retry$`) },
  { method: "PATCH", path: new RegExp(`^/clip-candidates/${ID}$`) },
  { method: "POST", path: new RegExp(`^/clip-candidates/${ID}/favorite$`) },
  { method: "POST", path: new RegExp(`^/clip-candidates/open$`) },
  { method: "POST", path: new RegExp(`^/clip-candidates/batch-render$`) },
  { method: "GET", path: new RegExp(`^/clip-candidates/batch-status$`) },
  { method: "GET", path: new RegExp(`^/clients/${ID}/clip-search$`) },
);

/** True when a bot-role token may make this request. */
export function botAllowed(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return ALLOW.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}
