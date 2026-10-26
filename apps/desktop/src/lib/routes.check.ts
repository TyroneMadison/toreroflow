/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Paths to screens and back, the fallbacks, the query, and the bot token on a
 * deep link.
 */
import { SECTIONS } from "./nav";
import { canonicalUrl, clientPath, parseUrl, pathFor, PATHS, SETTINGS_SECTIONS, scrubToken } from "./routes";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// Every screen has a unique path that parses back to it.
const screens = SECTIONS.flatMap((s) => s.pages.map((p) => p.id));
eq(new Set(screens.map((s) => PATHS[s])).size, 14, "fourteen screens, fourteen paths");
for (const s of screens) eq(parseUrl(pathFor(s)).screen, s, `${PATHS[s]} round-trips to ${s}`);
for (const { id } of SETTINGS_SECTIONS) {
  const r = parseUrl(pathFor("settings", id));
  eq([r.screen, r.section], ["settings", id], `/settings/${id} round-trips`);
}
eq(parseUrl("/create/upload/").screen, "upload", "a trailing slash is the same page");
eq(parseUrl("/accounts").screen, "overview", "/accounts is Account Overview");

// Unknown paths go to the dashboard; the query survives.
eq(parseUrl("/").screen, "dashboard", "/ is the dashboard");
eq(parseUrl("/nope/at/all").screen, "dashboard", "an unknown path is the dashboard");
eq(canonicalUrl("/"), "/dashboard", "/ is rewritten to /dashboard");
eq(canonicalUrl("/nope?client=a"), "/dashboard?client=a", "the rewrite keeps the query");
eq(canonicalUrl("/create/upload?range=90"), "/create/upload?range=90", "a known path is left alone");
eq(canonicalUrl("/settings/nope"), "/settings", "an unknown Settings section opens Settings");

// Query.
const q = parseUrl("/dashboard?client=c_123&range=90");
eq([q.clientId, q.range], ["c_123", 90], "client and range parse");
eq(parseUrl("/analytics?range=all").range, "all", "range=all parses");
eq(parseUrl("/analytics?range=45").range, null, "an unoffered range is ignored");
eq(parseUrl("/dashboard?client=").clientId, null, "an empty client is no client");

// The bot token on a deep link: taken, scrubbed, and the page still opens.
const t = scrubToken("https://app.torerone.com/create/upload?client=c_1#token=abc%2Edef");
eq(t, { token: "abc.def", url: "/create/upload?client=c_1" }, "token read and scrubbed on a deep link");
eq(parseUrl(t!.url).screen, "upload", "the scrubbed URL still opens Upload");
eq(scrubToken("https://app.torerone.com/x#a=1&token=zz")?.token, "zz", "token after another fragment param");
eq(scrubToken("https://app.torerone.com/dashboard"), null, "no fragment, no token");

// Client deep links for the Ready queue and the schedule page.
const cr = parseUrl("/clients/caleb/ready");
eq([cr.screen, cr.slug, cr.cardId], ["ready", "caleb", null], "/clients/caleb/ready opens Caleb's queue");
const cs = parseUrl("/clients/dudley/schedule/64ab12?step=caption");
eq([cs.screen, cs.slug, cs.cardId, cs.step], ["schedule", "dudley", "64ab12", "caption"], "schedule deep link parses");
eq(canonicalUrl("/clients/caleb/ready/"), "/clients/caleb/ready", "client path survives canonicalising");
eq(canonicalUrl("/clients/jacoby/schedule/x1?step=sop"), "/clients/jacoby/schedule/x1?step=sop", "schedule path and step survive");
eq(canonicalUrl("/create/schedule"), "/create/ready", "a schedule page without a card falls back to the queue");
eq(clientPath("caleb"), "/clients/caleb/ready", "clientPath builds the queue link");
eq(clientPath("caleb", "c9"), "/clients/caleb/schedule/c9", "clientPath builds the schedule link");
eq(clientPath(null), "/create/ready", "no client is the all-clients queue");
eq(parseUrl("/clients/a b/ready").screen, "dashboard", "an unsafe slug is not a route");
eq(parseUrl("/create/upload?schedule=m1&step=details").scheduleId, "m1", "an open schedule flow is in the URL");
eq(parseUrl("/create/upload?schedule=m1&dest=both").dest, "both", "a long-form destination is in the URL");
eq(parseUrl("/create/edit?area=ideas").area, "ideas", "Studio's open area is in the URL");

console.log("routes: all checks passed");

// The comments inbox has its own address.
eq(parseUrl("/comments").screen, "comments", "/comments opens the comments inbox");
