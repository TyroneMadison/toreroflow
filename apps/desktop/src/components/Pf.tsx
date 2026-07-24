export type PlatformId = "ig" | "tt" | "yt" | "sc";

/** Frosted-glass platform tile, e.g. <span class="pf sm ig"><svg><use href="#p-ig"/></svg></span> */
export default function Pf({ p, size }: { p: PlatformId; size?: "sm" | "lg" }) {
  return (
    <span className={`pf${size ? ` ${size}` : ""} ${p}`}>
      <svg>
        <use href={`#p-${p}`} />
      </svg>
    </span>
  );
}
