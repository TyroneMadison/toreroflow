import type { ClientSummary } from "../lib/api";
import { brandColor, clientAvatarUrl } from "../lib/avatar";

/** Round brand avatar: the real profile picture, else a letter on the brand's colour. */
export default function BrandAvatar({
  client,
  index,
  size = 40,
}: {
  client: ClientSummary;
  index: number;
  size?: number;
}) {
  const url = clientAvatarUrl(client);
  return (
    <span
      className="tf-av"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(160deg,${brandColor(index)},rgba(0,0,0,.35))`,
      }}
    >
      {url ? <img src={url} alt="" /> : (client.avatarSeed ?? client.name.slice(0, 1).toUpperCase())}
    </span>
  );
}
