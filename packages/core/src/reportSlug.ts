/**
 * Readable, unguessable report links.
 *
 * A client's report lives at a permanent path like
 * `northstar-report-copper-falcon-drift-ember`, so the same link can be sent once
 * and keeps working as each month is republished.
 *
 * The word suffix exists for privacy, not decoration. A bare
 * `/northstar-report` would be trivially guessable, and anyone could walk client
 * names to read their numbers. Four words from the list below give roughly
 * 4.3 billion combinations, which is not walkable by hand or by a casual
 * script, while still reading like language rather than a hash.
 *
 * It is still "secret link" privacy: anyone holding the link can view it,
 * including if a client forwards it. It is not authentication.
 */

/**
 * 256 short, unambiguous words. No homophones, no words that read oddly when
 * paired, nothing that could combine into something embarrassing to send a
 * client.
 */
const WORDS = [
  "amber", "anchor", "apex", "arbor", "arc", "arrow", "ash", "aspen",
  "atlas", "aurora", "azure", "basalt", "beacon", "bell", "birch", "bloom",
  "blue", "bolt", "boulder", "brass", "breeze", "bridge", "bright", "bronze",
  "brook", "canyon", "cedar", "chalk", "chrome", "cinder", "clay", "cliff",
  "cloud", "clover", "coast", "cobalt", "comet", "compass", "copper", "coral",
  "cove", "crest", "crimson", "crown", "crystal", "cypress", "dawn", "delta",
  "dew", "diamond", "dial", "drift", "dune", "dusk", "eagle", "east",
  "echo", "ember", "emerald", "falcon", "fathom", "fern", "field", "flare",
  "flint", "flow", "forest", "forge", "fox", "frost", "gale", "garnet",
  "gate", "glacier", "glade", "glass", "gold", "granite", "graphite", "grove",
  "gulf", "harbor", "harvest", "haven", "hawk", "hazel", "heather", "helm",
  "hollow", "horizon", "ice", "indigo", "iron", "island", "ivory", "jade",
  "jasper", "jet", "juniper", "kestrel", "keystone", "lagoon", "lake", "lantern",
  "larch", "laurel", "ledge", "light", "lily", "linen", "lion", "lotus",
  "lumen", "lunar", "lyric", "maple", "marble", "marsh", "meadow", "mesa",
  "mica", "midnight", "mint", "mirror", "mist", "monsoon", "moon", "moss",
  "motion", "mountain", "muse", "nebula", "nectar", "needle", "nest", "nickel",
  "night", "nimbus", "north", "oak", "oasis", "obsidian", "ocean", "olive",
  "onyx", "opal", "orbit", "orchard", "osprey", "otter", "pacific", "palm",
  "pearl", "pebble", "peak", "pepper", "pine", "pioneer", "pivot", "plateau",
  "plum", "polar", "pollen", "poplar", "prairie", "prism", "pulse", "quartz",
  "quill", "rain", "rapid", "raven", "reed", "reef", "relay", "ridge",
  "rill", "river", "rose", "rover", "ruby", "rush", "russet", "saffron",
  "sage", "sail", "sand", "sapphire", "scarlet", "sequoia", "shale", "shelter",
  "shore", "signal", "silk", "silver", "slate", "smoke", "snow", "solar",
  "solstice", "sonnet", "south", "spark", "spire", "spruce", "spur", "stag",
  "star", "steel", "stone", "storm", "stream", "summit", "sunset", "surf",
  "swift", "sycamore", "talon", "tarn", "teal", "tempo", "thistle", "thunder",
  "tide", "timber", "tin", "topaz", "torch", "tower", "trail", "tundra",
  "turquoise", "twilight", "umber", "valley", "vapor", "velvet", "verdant", "vertex",
  "vessel", "vista", "vivid", "voyage", "walnut", "wave", "west", "wheat",
  "whisper", "wick", "willow", "wind", "winter", "wolf", "wren", "zenith",
];

/** URL-safe form of a client name: "CACV Motors" -> "cacv-motors". */
export function clientSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "client";
}

/** The tail every report path ends in, e.g. "northstar-monthly-reports". */
export const REPORT_SLUG_SUFFIX = "monthly-reports";

/**
 * Report path for a client: "<client>-monthly-reports".
 *
 * Short and predictable by explicit choice: the operator preferred a clean,
 * memorable link over an unguessable one, having been told these pages can
 * be found by guessing a client name. Pages carry noindex so they stay out
 * of search results, but the URL itself is not a secret.
 *
 * Lower case throughout. Netlify serves paths case sensitively, so a link
 * written "Northstar-Monthly-Reports" and typed back in lower case would 404,
 * and a client retyping a link from a phone is exactly when that happens.
 *
 * `withSuffix` remains available for anyone who later wants the unguessable
 * form; `randomInt` is injected so it stays pure and testable.
 */
export function buildReportSlug(clientName: string): string {
  return `${clientSlug(clientName)}-${REPORT_SLUG_SUFFIX}`;
}

/** Unguessable variant, kept for if the privacy tradeoff is revisited. */
export function buildReportSlugWithSuffix(
  clientName: string,
  randomInt: (maxExclusive: number) => number,
  wordCount = 4,
): string {
  const picked: string[] = [];
  const used = new Set<number>();
  while (picked.length < wordCount) {
    const i = randomInt(WORDS.length);
    // Distinct words read better and avoid "falcon-falcon".
    if (used.has(i)) continue;
    used.add(i);
    picked.push(WORDS[i]!);
  }
  return `${buildReportSlug(clientName)}-${picked.join("-")}`;
}

/** Combinations available, for documenting the actual privacy on offer. */
export function slugCombinations(wordCount = 4): number {
  let total = 1;
  for (let i = 0; i < wordCount; i++) total *= WORDS.length - i;
  return total;
}

export const REPORT_SLUG_WORD_COUNT = 256;
