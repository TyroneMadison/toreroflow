import type { ReactNode } from "react";
import { useIsPhone } from "../../lib/phone";
import Pf from "../Pf";
import type { PlatformId } from "../Pf";

/**
 * One folded row per platform's options on the phone (mobile pass): the
 * platform, a one-line summary, and every option inside when opened. Above
 * the phone width the children render exactly as before.
 */
export default function PhoneFold({ title, summary, pf, open, children }: { title: string; summary?: string; pf?: PlatformId; open?: boolean; children: ReactNode }) {
  const isPhone = useIsPhone();
  if (!isPhone) return <>{children}</>;
  return (
    <details className="mb-fold" open={open}>
      <summary>
        {pf && <Pf p={pf} size="sm" />}
        <span className="mb-lt">
          <b>{title}</b>
          {summary && <small>{summary}</small>}
        </span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <use href="#i-chev" />
        </svg>
      </summary>
      <div className="mb-foldb">{children}</div>
    </details>
  );
}
