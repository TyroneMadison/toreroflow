import type { ClientSummary } from "../lib/api";
import { brandColor, clientAvatarUrl, initials } from "../lib/avatar";
import { useIsPhone } from "../lib/phone";

/** Round brand avatar: the real profile picture, else a letter on the brand's colour.
 *  Phones show 1 to 2 initials so the text always fits the circle. */
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
  const isPhone = useIsPhone();
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
      {url ? <img src={url} alt="" /> : isPhone ? initials(client.name) : (client.avatarSeed ?? client.name.slice(0, 1).toUpperCase())}
    </span>
  );
}
