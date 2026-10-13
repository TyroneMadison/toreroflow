/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Paths to screens and back, the fallbacks, the query, and the bot token on a
 * deep link.
 */
import { SECTIONS } from "./nav";
import { canonicalUrl, parseUrl, pathFor, PATHS, SETTINGS_SECTIONS, scrubToken } from "./routes";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// Every screen has a unique path that parses back to it.
const screens = SECTIONS.flatMap((s) => s.pages.map((p) => p.id));
eq(new Set(screens.map((s) => PATHS[s])).size, 11, "eleven screens, eleven paths");
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

console.log("routes: all checks passed");
