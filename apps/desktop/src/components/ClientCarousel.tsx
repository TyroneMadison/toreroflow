import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import Pf from "./Pf";
import { api, type ClientAnalytics, type OverviewClient } from "../lib/api";
import { brandColor } from "../lib/avatar";
import { PF_ID } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import "./ClientCarousel.css";

/** Px between card centres; a drag of one spacing moves one card. */
const SPACING = 210;
/** Px a pointer must travel before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 8;

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/**
 * Every brand as a card along the top of Account Overview. The centred card is
 * the selected client, so gliding the carousel switches the brand everywhere
 * that reads selectedClient, including the hero card below.
 */
export default function ClientCarousel({ clients }: { clients: OverviewClient[] }) {
  const { selectedClient, selectClient } = useAppState();
  const found = clients.findIndex((c) => c.id === selectedClient?.id);
  const idx = found < 0 ? 0 : found;

  // 30-day views per client, from the same analytics endpoint Analytics and
  // Dashboard read. Missing or failed stays undefined and renders "?".
  const [views, setViews] = useState<Record<string, number>>({});
  const ids = clients.map((c) => c.id).join(",");
  useEffect(() => {
    let live = true;
    void Promise.allSettled(
      clients.map((c) => api.get<ClientAnalytics>(`/clients/${c.id}/analytics?days=30`)),
    ).then((rs) => {
      if (!live) return;
      const next: Record<string, number> = {};
      rs.forEach((r, i) => {
        if (r.status === "fulfilled") next[clients[i]!.id] = r.value.totals.views;
      });
      setViews(next);
    });
    return () => {
      live = false;
    };
    // Keyed on the id list, not the array, which is new on every overview poll.
  }, [ids]);

  const [dragX, setDragX] = useState(0);
  const drag = useRef<{ x: number; id: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const go = (i: number) => {
    const n = Math.max(0, Math.min(clients.length - 1, i));
    if (clients[n] && clients[n].id !== selectedClient?.id) selectClient(clients[n].id);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      // Capture only once it is a drag, so a plain click still lands on its card.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setDragX(dx);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    suppressClick.current = true;
    const dx = e.clientX - d.x;
    const steps = Math.round(-dx / SPACING) || (Math.abs(dx) > 40 ? -Math.sign(dx) : 0);
    setDragX(0);
    go(idx + steps);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") go(idx - 1);
    else if (e.key === "ArrowRight") go(idx + 1);
    else return;
    e.preventDefault();
  };

  // Keep focus on the centred card when the keyboard moved it.
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (track.current?.contains(document.activeElement)) {
      track.current.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }, [idx]);

  if (clients.length === 0) return null;
  const current = clients[idx]!;

  return (
    <section
      className="ccar"
      data-testid="ao.client-carousel"
      role="region"
      aria-roledescription="carousel"
      aria-label="Clients"
      onKeyDown={onKeyDown}
    >
      <button type="button" className="ccar-nav prev" aria-label="Previous client" disabled={idx === 0} onClick={() => go(idx - 1)}>
        ‹
      </button>
      <div
        ref={track}
        className={`ccar-track${dragX ? " dragging" : ""}`}
        role="listbox"
        aria-label="Choose a client"
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {clients.map((c, i) => {
          const d = i - idx + dragX / SPACING;
          const a = Math.min(Math.abs(d), 3);
          const on = i === idx;
          const v = views[c.id];
          return (
            <div
              key={c.id}
              role="option"
              aria-selected={on}
              aria-current={on ? "true" : undefined}
              aria-label={`${c.name}, ${v === undefined ? "views unknown" : `${v.toLocaleString()} views`} in 30 days`}
              tabIndex={on ? 0 : -1}
              className={`ccar-card glass-z1${on ? " on" : ""}`}
              data-testid={`ao.client-card.${c.id}`}
              style={{
                transform: `translate(-50%,-50%) translateX(${d * SPACING}px) scale(${1 - a * 0.16})`,
                opacity: Math.max(0, 1 - a * 0.32),
                filter: a < 0.05 ? "none" : `blur(${a * 2.2}px)`,
                zIndex: 10 - Math.round(a),
                visibility: a >= 3 ? "hidden" : undefined,
              }}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                go(i);
              }}
            >
              <span className="ccar-av" style={{ background: `linear-gradient(160deg,${brandColor(i)},rgba(0,0,0,.35))` }}>
                {c.avatarUrl ? <img src={c.avatarUrl} alt="" draggable={false} /> : (c.avatarSeed ?? c.name.slice(0, 1).toUpperCase())}
              </span>
              <b className="ccar-name">{c.name}</b>
              <span className="ccar-views">
                <strong>{v === undefined ? "?" : compact.format(v)}</strong>
                <small>views · 30d</small>
              </span>
              <span className="ccar-plats">
                {c.platforms.map((p) => (
                  <Pf key={p.platform} p={PF_ID[p.platform]} size="sm" />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="ccar-nav next"
        aria-label="Next client"
        disabled={idx === clients.length - 1}
        onClick={() => go(idx + 1)}
      >
        ›
      </button>
      <p className="ccar-hud" aria-live="polite">
        {String(idx + 1).padStart(2, "0")} / {String(clients.length).padStart(2, "0")} · {current.name}
      </p>
    </section>
  );
}
