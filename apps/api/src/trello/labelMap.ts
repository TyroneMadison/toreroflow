/*
 * Which Toreroflow client a Trello card on the editor pipeline belongs to,
 * decided by its color label. Pure, so it is checked without Trello or a DB.
 */

/** Trello's own color names, with the _dark and _light variants folded in. */
export function baseColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const c = color.toLowerCase().replace(/_(dark|light)$/, "");
  // Trello has no "gray" or "gold"; people say them for black and yellow.
  if (c === "gray" || c === "grey") return "black";
  if (c === "gold") return "yellow";
  return c;
}

/** Built-in routing, used for any client that has not set its own colors. */
export const DEFAULT_LABEL_MAP: Record<string, string> = {
  red: "caleb",
  black: "dudley",
  yellow: "jacoby",
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface MappableClient {
  id: string;
  name: string;
  slug: string | null;
  trelloLabels: string[];
}

/** The deep-link handle: the stored slug, else the slugified name. */
export function clientSlug(c: { name: string; slug: string | null }): string {
  return c.slug || slugify(c.name);
}

/** A default key ("caleb") names a client when it is its slug or a word of its name. */
function matchesKey(c: MappableClient, key: string): boolean {
  return clientSlug(c) === key || slugify(c.name).split("-").includes(key);
}

/** color -> client id, explicit colors first, then the defaults. */
export function buildLabelMap(clients: MappableClient[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of clients)
    for (const color of c.trelloLabels) {
      const b = baseColor(color);
      if (b && !map.has(b)) map.set(b, c.id);
    }
  for (const [color, key] of Object.entries(DEFAULT_LABEL_MAP)) {
    if (map.has(color)) continue;
    const hit = clients.find((c) => c.trelloLabels.length === 0 && matchesKey(c, key));
    if (hit) map.set(color, hit.id);
  }
  return map;
}

/**
 * The client for a card's labels. Null (held) when no label maps, or when two
 * labels map to different clients: a guess would post to the wrong account.
 */
export function resolveCard(
  labelColors: (string | null)[],
  map: Map<string, string>,
): { clientId: string | null; reason: "mapped" | "unlabeled" | "unmapped" | "conflict" } {
  const colors = labelColors.map(baseColor).filter((c): c is string => !!c);
  if (!colors.length) return { clientId: null, reason: "unlabeled" };
  const ids = [...new Set(colors.map((c) => map.get(c)).filter((x): x is string => !!x))];
  if (ids.length === 0) return { clientId: null, reason: "unmapped" };
  if (ids.length > 1) return { clientId: null, reason: "conflict" };
  return { clientId: ids[0]!, reason: "mapped" };
}
