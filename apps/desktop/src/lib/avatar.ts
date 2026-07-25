import type { ClientSummary } from "./api";

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
