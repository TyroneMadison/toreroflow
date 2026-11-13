import type { ClientSummary } from "./api";

/** Each brand's colour, by its place in the client list: card avatar, chart
 *  line and legend dot all use the same one. */
const BRAND_COLORS = ["#FF7A66", "#6fb0ff", "#F2BE6E", "#B794FF", "#4ADE9A", "#FF8FB8"];
export const brandColor = (index: number): string =>
  BRAND_COLORS[index % BRAND_COLORS.length]!;

/** One or two letters for a round avatar: "Northwind Studio" -> "NS", "Acme" -> "A". */
export const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? "").join("").toUpperCase() || "?";

/**
 * Best real profile picture for a client: Instagram's avatar first (usually
 * the brand's face), then any other connected account's, else null.
 */
export function clientAvatarUrl(client: ClientSummary): string | null {
  const connected = client.accounts.filter((a) => a.status === "connected");
  return (
    connected.find((a) => a.platform === "instagram" && a.avatarUrl)?.avatarUrl ??
    connected.find((a) => a.avatarUrl)?.avatarUrl ??
    null
  );
}
