/**
 * What an idea needs to film: specific props, locations and people, shown up
 * front on the card ("Needs a car"). Max 4, empty when nothing special.
 */
export const NEED_TYPES = ["prop", "location", "people"] as const;
export type NeedType = (typeof NEED_TYPES)[number];
export interface Need { type: NeedType; label: string }

export const NEEDS_RULES =
  "needs lists what the idea specifically requires beyond a phone and one person, at most 4, " +
  "each { type: prop | location | people, label } with label starting 'Needs', short and concrete " +
  "(e.g. Needs a kitchen, Needs two people, Needs a car, Needs a mirror). Empty list if nothing special.";

/** Things a shot title can mention that the shoot then has to have. */
const SHOT_LEXICON: Array<[RegExp, Need]> = [
  [/\bcar\b|\bsuv\b|\btruck\b|\bvan\b/i, { type: "prop", label: "Needs a car" }],
  [/\bmirror\b/i, { type: "prop", label: "Needs a mirror" }],
  [/\bkitchen\b/i, { type: "location", label: "Needs a kitchen" }],
  [/\bwhiteboard\b/i, { type: "prop", label: "Needs a whiteboard" }],
  [/\blaptop\b/i, { type: "prop", label: "Needs a laptop" }],
  [/\bgym\b/i, { type: "location", label: "Needs a gym" }],
  [/\boffice\b|\bdesk\b/i, { type: "location", label: "Needs a desk" }],
  [/\boutside\b|\bstreet\b|\bparking lot\b/i, { type: "location", label: "Needs an outdoor spot" }],
];

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, couple: 2 };

/** How many people a "people" need implies (default 2: someone besides the host). */
export function peopleCount(label: string): number {
  const m = label.toLowerCase().match(/\b(\d+|two|three|four|five|couple)\b/);
  if (!m) return 2;
  return WORDS[m[1]!] ?? Math.max(1, Number(m[1]));
}

/** Cleans model needs, merges in props and places named in the shot list, dedupes, caps at 4. */
export function cleanNeeds(raw: unknown, shotTitles: readonly string[] = []): Need[] {
  const out: Need[] = [];
  const seen = new Set<string>();
  const push = (n: Need) => {
    const label = n.label.replace(/[\u2013\u2014]/g, ",").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!label) return;
    const fixed = /^needs\b/i.test(label) ? label[0]!.toUpperCase() + label.slice(1) : `Needs ${label}`;
    const key = fixed.toLowerCase();
    if (seen.has(key) || out.length >= 4) return;
    seen.add(key);
    out.push({ type: n.type, label: fixed });
  };
  for (const r of Array.isArray(raw) ? raw : []) {
    const type = String((r as Need)?.type ?? "").toLowerCase() as NeedType;
    if (!(NEED_TYPES as readonly string[]).includes(type)) continue;
    push({ type, label: String((r as Need)?.label ?? "") });
  }
  const text = shotTitles.join(" ");
  for (const [re, need] of SHOT_LEXICON) if (re.test(text)) push(need);
  return out;
}

/** Feeds needs into the difficulty check: people on camera, locations, prop count. */
export function needsLoad(needs: readonly Need[]): { actors: number; locations: number; props: number } {
  const people = needs.filter((n) => n.type === "people");
  return {
    actors: people.length ? Math.max(...people.map((n) => peopleCount(n.label))) : 1,
    locations: Math.max(1, needs.filter((n) => n.type === "location").length),
    props: needs.filter((n) => n.type === "prop").length,
  };
}
