import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * Small phone pieces the Reports pages share (mobile pass). Phone only: every
 * caller renders them inside its useIsPhone() branch.
 */

export function Ic({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <use href={`#${name}`} />
    </svg>
  );
}

/**
 * The one line under the title and the head's icon buttons, placed inside the
 * shared phone page head (PageHeader's .mb-ph), which has no slot for them.
 * ponytail: a portal into PageHeader's markup; an `actions`/`subtitle` slot on
 * the phone PageHeader would replace this.
 */
export function PhoneHead({ screen, sub, actions }: { screen: string; sub?: ReactNode; actions?: ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const el = document.querySelector(`[data-phone-head="${screen}"] .mb-ph`);
    if (el !== host) setHost(el);
  });
  if (!host) return null;
  return (
    <>
      {sub && host.firstElementChild && createPortal(<div className="mb-sub rp-sub">{sub}</div>, host.firstElementChild)}
      {actions && createPortal(<div className="mb-phact">{actions}</div>, host)}
    </>
  );
}

/**
 * A bottom sheet in the phone's sheet style: grab handle (drag down closes),
 * title, 44px close, a scrolling body and an optional sticky footer. Escape
 * and the scrim close it. Rendered on body so no animated ancestor moves it.
 */
export function Sheet({
  label,
  title,
  sub,
  lead,
  onClose,
  foot,
  className,
  testId,
  top = false,
  children,
}: {
  label: string;
  title: ReactNode;
  sub?: ReactNode;
  lead?: ReactNode;
  onClose(): void;
  foot?: ReactNode;
  className?: string;
  testId?: string;
  /** Above a modal sheet (the modal overlay sits over the page sheets). */
  top?: boolean;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    sheet.current.style.transition = "none";
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!sheet.current || !d) return;
    sheet.current.style.transition = "transform .18s ease";
    if (d.dy > 110) onClose();
    else sheet.current.style.transform = "";
  };
  return createPortal(
    <>
      <div className={`mb-scrim${top ? " top" : ""}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={sheet}
        className={`mb-sheet rp-sheet${top ? " top" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
      >
        <div className="mb-grab rp-grab" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <div className="mb-sh">
          {lead}
          <div className="mb-ttl">
            <h2>{title}</h2>
            {sub && <small>{sub}</small>}
          </div>
          <button type="button" className="mb-ib" aria-label="Close" onClick={onClose}>
            <Ic name="i-x" />
          </button>
        </div>
        <div className="mb-shb">{children}</div>
        {foot && <div className="rp-shf">{foot}</div>}
      </div>
    </>,
    document.body,
  );
}

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
  lead?: ReactNode;
}

/** A sheet that picks one option, with a check on the current one and an optional search box. */
export function PickSheet({
  label,
  value,
  options,
  onPick,
  onClose,
  search,
  testId,
  top,
}: {
  label: string;
  value: string;
  options: PickOption[];
  onPick(value: string): void;
  onClose(): void;
  /** Placeholder for a search box; no box without it. */
  search?: string;
  testId?: string;
  top?: boolean;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle)) : options;
  return (
    <Sheet label={label} title={label} onClose={onClose} testId={testId} top={top}>
      {search && (
        <label className="mb-search">
          <Ic name="i-search" />
          <input type="search" placeholder={search} value={q} onChange={(e) => setQ(e.target.value)} aria-label={search} />
        </label>
      )}
      <div className="mb-card list" role="listbox" aria-label={label}>
        {shown.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            className="mb-lrow"
            onClick={() => {
              onPick(o.value);
              onClose();
            }}
          >
            {o.lead}
            <span className="mb-lt">
              <b>{o.label}</b>
              {o.hint && <small>{o.hint}</small>}
            </span>
            {o.value === value && (
              <span className="rp-ck">
                <Ic name="i-check" />
              </span>
            )}
          </button>
        ))}
        {!shown.length && <p className="rp-empty">Nothing matches.</p>}
      </div>
    </Sheet>
  );
}

/**
 * Pull down at the top of the page to refresh. Returns the little indicator to
 * render; it spins while `busy`. Does nothing while `enabled` is false.
 */
export function usePullToRefresh(onRefresh: () => void, busy: boolean, enabled = true): ReactNode {
  const [pull, setPull] = useState(0);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    const main = document.querySelector<HTMLElement>(".main");
    if (!main || !enabled) return;
    let y0: number | null = null;
    let d = 0;
    const start = (e: TouchEvent) => {
      y0 = main.scrollTop <= 0 ? e.touches[0]!.clientY : null;
      d = 0;
    };
    const move = (e: TouchEvent) => {
      if (y0 == null) return;
      d = Math.max(0, Math.min(90, (e.touches[0]!.clientY - y0) * 0.5));
      setPull(d);
    };
    const end = () => {
      if (y0 != null && d >= 60) cb.current();
      y0 = null;
      d = 0;
      setPull(0);
    };
    main.addEventListener("touchstart", start, { passive: true });
    main.addEventListener("touchmove", move, { passive: true });
    main.addEventListener("touchend", end);
    main.addEventListener("touchcancel", end);
    return () => {
      main.removeEventListener("touchstart", start);
      main.removeEventListener("touchmove", move);
      main.removeEventListener("touchend", end);
      main.removeEventListener("touchcancel", end);
    };
  }, [enabled]);
  if (!enabled || (!pull && !busy)) return null;
  return (
    <div
      className={`rp-ptr${busy && !pull ? " busy" : ""}`}
      role={busy ? "status" : undefined}
      aria-label={busy ? "Refreshing" : undefined}
      style={pull ? { opacity: Math.min(1, pull / 60), transform: `translate(-50%, ${pull}px) rotate(${pull * 4}deg)` } : undefined}
    >
      <Ic name="i-refresh" />
    </div>
  );
}

/** The phone's share sheet for a link, or the clipboard where there is none. Says which happened. */
export async function shareLink(url: string, title: string): Promise<"shared" | "copied" | "failed"> {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (err) {
      // Closing the share sheet is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return "shared";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
