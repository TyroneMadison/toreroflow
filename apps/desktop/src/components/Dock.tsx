import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { dockSection, SECTIONS, type ScreenId, type SectionId } from "../lib/nav";
import { linkProps, useRoute } from "../lib/routes";
import { aiming, defaultPlace, DOCK_TIMING as T, itemFor, menuItems, menuShift, rememberPage, tabTarget, type Pt } from "../lib/dockMenu";
import { useFailedPosts } from "../lib/failedPosts";
import type { Theme } from "../lib/theme";
import { useAppState } from "../state/AppState";
import type { useApiStatus } from "./ApiStatus";
import BrandAvatar from "./BrandAvatar";

interface DockProps {
  activeScreen: ScreenId;
  /** Polled once by the shell, which also publishes it for agents. */
  api: ReturnType<typeof useApiStatus>;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenConnect: () => void;
  /** Hover text for the Reports bell; null hides it. */
  reportNotice: string | null;
  /** Open background failures, shown wherever the operator is. */
  alertCount: number;
  alertIsError: boolean;
}

type Open = { id: SectionId; swap: boolean } | null;

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const noStore = { getItem: () => null, setItem: () => {} };

/**
 * The bottom dock: API status on the left, the four sections in the middle,
 * theme and the active brand on the right. Each section has a drop-up menu of
 * its pages (round 2 mockups): it opens after the pointer rests 80ms, stays
 * open across the bridge and on the aim line up to it, and closes 250ms after
 * the pointer leaves. A click on the tab reopens the last page used in it.
 * Keyboard: focus opens it, arrows move, Enter opens, Escape closes. Touch: the
 * first tap opens the menu, a second tap opens the page. The phone hides all
 * of this and keeps its tab bar (MobileNav).
 */
export default function Dock({
  activeScreen,
  api,
  theme,
  onToggleTheme,
  onOpenConnect,
  reportNotice,
  alertCount,
  alertIsError,
}: DockProps) {
  const { clients, selectedClient, selectClient } = useAppState();
  const { section } = useRoute();
  const failed = useFailedPosts();
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [instant, setInstant] = useState<SectionId | null>(null);
  const [shift, setShift] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const active = dockSection(activeScreen);
  const here = { screen: activeScreen, section };
  const selectedIndex = clients.findIndex((c) => c.id === selectedClient?.id);
  const failedCount = failed?.count ?? 0;

  // Hover intent lives in refs: timers and the pointer trail change far more
  // often than anything on screen.
  const openRef = useRef<SectionId | null>(null);
  const timers = useRef({ open: 0, close: 0, aim: 0 });
  const trail = useRef<Pt[]>([]);
  const pointerType = useRef("mouse");
  const lastClosed = useRef(0);
  const suppressFocus = useRef(false);

  const clearTimers = () => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
    clearTimeout(timers.current.aim);
  };
  const show = (id: SectionId, swap: boolean) => {
    clearTimers();
    if (openRef.current === id) return;
    const prev = openRef.current;
    openRef.current = id;
    if (prev) setInstant(prev); // the menu being replaced goes at once
    setOpen({ id, swap });
  };
  const hide = (instantly = false) => {
    clearTimers();
    const prev = openRef.current;
    if (!prev) return;
    openRef.current = null;
    lastClosed.current = performance.now();
    if (instantly) setInstant(prev);
    setOpen(null);
  };

  // .instant must reach the styles before it comes off, or the closing fade runs.
  useLayoutEffect(() => {
    if (!instant) return;
    void navRef.current?.offsetWidth;
    setInstant(null);
  }, [instant]);

  // Keep an open menu inside the window (narrow windows, tabs near an edge).
  useLayoutEffect(() => {
    if (!open) return setShift(0);
    const r = document.getElementById(`dm-${open.id}`)?.getBoundingClientRect();
    if (r) setShift((s) => s + menuShift(r.left, r.right, window.innerWidth));
  }, [open]);

  // The page you are on is the last one used in its tab.
  useEffect(() => {
    rememberPage({ screen: activeScreen, section }, store() ?? noStore);
  }, [activeScreen, section]);

  // A route change (any link, back/forward) closes the menu.
  useEffect(() => hide(true), [activeScreen, section]);

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      trail.current.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (trail.current.length > 12) trail.current.shift();
    };
    const onDown = (e: globalThis.PointerEvent) => {
      pointerType.current = e.pointerType || "mouse";
      if (openRef.current && !navRef.current?.contains(e.target as Node)) hide();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !openRef.current) return;
      if (!document.getElementById(`dt-${openRef.current}`)?.contains(document.activeElement)) hide();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onEnter = (id: SectionId) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timers.current.close);
    if (openRef.current === id) return clearTimeout(timers.current.aim);
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.aim);
    if (openRef.current) {
      const menu = document.getElementById(`dm-${openRef.current}`)?.getBoundingClientRect();
      const to = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (menu && aiming(trail.current[trail.current.length - 2], to, menu)) {
        // Crossing this tab on the way up to the open menu: keep it, unless the pointer stops here.
        const el = e.currentTarget;
        timers.current.aim = window.setTimeout(() => el.matches(":hover") && show(id, true), T.aimGrace);
        return;
      }
      return show(id, true);
    }
    timers.current.open = window.setTimeout(() => show(id, false), T.openDelay);
  };
  const onLeave = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timers.current.aim);
    clearTimeout(timers.current.open);
    if (!openRef.current) return;
    clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => hide(), T.closeDelay);
  };

  const onKeyDown = (id: SectionId) => (e: KeyboardEvent<HTMLDivElement>) => {
    const dt = e.currentTarget;
    const items = [...dt.querySelectorAll<HTMLElement>(".mi")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => items[(n + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        // The menu must be visible before a page in it can take focus.
        if (openRef.current !== id) flushSync(() => show(id, false));
        if (i < 0) go(e.key === "ArrowUp" ? items.length - 1 : 0);
        else go(i + (e.key === "ArrowUp" ? -1 : 1));
        break;
      case "Home":
      case "End":
        if (i >= 0) {
          e.preventDefault();
          go(e.key === "Home" ? 0 : items.length - 1);
        }
        break;
      case "Escape":
        if (openRef.current === id) {
          e.preventDefault();
          hide();
          suppressFocus.current = true;
          dt.querySelector<HTMLElement>(".di")?.focus();
          suppressFocus.current = false;
        }
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const tabs = [...(navRef.current?.querySelectorAll<HTMLElement>(".dt>.di") ?? [])];
        const at = tabs.findIndex((t) => dt.contains(t));
        tabs[(at + (e.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length]?.focus();
        break;
      }
      case "Tab":
        hide();
        break;
    }
  };

  return (
    <nav className="dock glass-z1" aria-label="Primary" ref={navRef} data-testid="nav.dock">
      <span className="di di-status" title={api.title} role="status" data-testid="nav.api-status">
        <span className="tf-dot" style={{ background: api.color, boxShadow: `0 0 10px ${api.color}` }} />
        <span className="di-lbl">{api.label}</span>
      </span>
      {alertCount > 0 && (
        <a
          className={`di di-alert${alertIsError ? " bad" : ""}`}
          {...linkProps("reports")}
          title="Open the Reports screen to see what failed"
          data-testid="nav.alerts"
        >
          <span className="tf-badge">{alertCount}</span>
          <span className="di-lbl">{alertCount === 1 ? "problem" : "problems"}</span>
        </a>
      )}
      <span className="sep" />

      {SECTIONS.map((s) => {
        const items = menuItems(s.id);
        const target = tabTarget(s.id, store() ?? noStore, here);
        const tabLink = linkProps(target.screen, target.section);
        const opensKey = itemFor(s.id, target);
        const firstKey = itemFor(s.id, defaultPlace(s.id));
        const currentKey = itemFor(s.id, here);
        // The tag marks what a click on the tab opens: its first page, or the
        // last page used in it (not repeated on the page you are already on).
        const tag = opensKey === firstKey ? "Opens first" : opensKey !== currentKey ? "Last used" : null;
        const isOpen = open?.id === s.id;
        const on = active === s.id;
        const bell = s.id === "reports" && reportNotice;
        return (
          <div
            key={s.id}
            id={`dt-${s.id}`}
            className={`dt${isOpen ? " open" : ""}${isOpen && open.swap ? " swap" : ""}${instant === s.id ? " instant" : ""}`}
            onPointerEnter={onEnter(s.id)}
            onPointerLeave={onLeave}
            onKeyDown={onKeyDown(s.id)}
            onBlur={(e) => {
              const dt = e.currentTarget;
              if (openRef.current === s.id && !dt.contains(e.relatedTarget as Node | null) && !dt.matches(":hover")) hide();
            }}
          >
            <a
              className={`di${on ? " on" : ""}`}
              aria-current={on ? "page" : undefined}
              aria-label={s.label}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={`dm-${s.id}`}
              title={bell ? reportNotice : undefined}
              href={tabLink.href}
              onClick={(e) => {
                // On touch or pen the first tap opens the menu; the next opens the page.
                if (e.detail && pointerType.current !== "mouse" && openRef.current !== s.id) {
                  e.preventDefault();
                  show(s.id, false);
                  return;
                }
                hide();
                tabLink.onClick(e);
              }}
              onFocus={(e) => {
                if (suppressFocus.current || !e.currentTarget.matches(":focus-visible")) return;
                show(s.id, !!openRef.current || performance.now() - lastClosed.current < 300);
              }}
              data-testid={`nav.section.${s.id}`}
            >
              <svg aria-hidden="true">
                <use href={s.icon} />
              </svg>
              <span className="di-lbl">{s.label}</span>
              {bell && <span className="tf-bell" aria-hidden="true" />}
              <svg className="caret" aria-hidden="true">
                <use href="#i-chev-u" />
              </svg>
            </a>
            <div
              className="dm"
              id={`dm-${s.id}`}
              role="menu"
              aria-label={`${s.label} pages`}
              style={isOpen && shift ? ({ "--dx": `${shift}px` } as CSSProperties) : undefined}
              data-testid={`nav.menu.${s.id}`}
            >
              <div className="dm-h" aria-hidden="true">
                <span>{s.label}</span>
                <small>{items.length} pages</small>
              </div>
              {items.map((it, i) => {
                const link = linkProps(it.screen, it.section);
                const count = it.key === "failed" && failedCount > 0 ? failedCount : 0;
                return (
                  <a
                    key={it.key}
                    className="mi"
                    role="menuitem"
                    tabIndex={-1}
                    href={link.href}
                    onClick={(e) => {
                      link.onClick(e);
                      hide(true);
                    }}
                    style={{ "--i": i } as CSSProperties}
                    aria-current={it.key === currentKey ? "page" : undefined}
                    data-testid={it.testid}
                  >
                    <svg aria-hidden="true">
                      <use href={it.icon} />
                    </svg>
                    <span className="ml">{it.label}</span>
                    {count > 0 && (
                      <span className="cnt bad">
                        {count}
                        <span className="vh"> failed</span>
                      </span>
                    )}
                    {tag && it.key === opensKey && <small className="def">{tag}</small>}
                  </a>
                );
              })}
              <span className="tip" aria-hidden="true" />
            </div>
          </div>
        );
      })}

      <span className="sep" />
      <button
        type="button"
        className="di"
        role="switch"
        aria-checked={theme === "dark"}
        aria-label="Dark theme"
        onClick={onToggleTheme}
        data-testid="theme.toggle"
      >
        <svg aria-hidden="true">
          <use href={theme === "light" ? "#i-sun" : "#i-moon"} />
        </svg>
        <span className={`tog${theme === "dark" ? " on" : ""}`} aria-hidden="true" />
      </button>

      <div className="tf-brandwrap" ref={wrapRef}>
        <button
          type="button"
          className="di di-brand"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Active brand: ${selectedClient?.name ?? "none"}. Switch brand`}
          onClick={() => setMenuOpen((o) => !o)}
          data-testid="brand-switcher.open"
        >
          {selectedClient && <BrandAvatar client={selectedClient} index={selectedIndex} />}
          <span className="di-lbl di-brandtext">
            <b>{selectedClient?.name ?? (clients.length ? "Pick a brand" : "No brands yet")}</b>
            <small>Active brand ▾</small>
          </span>
        </button>
        {menuOpen && (
          <div className="tf-menu glass-z3" role="menu" aria-label="Brands">
            {clients.map((client, i) => (
              <button
                key={client.id}
                type="button"
                role="menuitemradio"
                aria-checked={client.id === selectedClient?.id}
                className={`tf-mi${client.id === selectedClient?.id ? " on" : ""}`}
                onClick={() => {
                  selectClient(client.id);
                  setMenuOpen(false);
                }}
                data-testid={`brand-switcher.option.${client.id}`}
              >
                <BrandAvatar client={client} index={i} size={28} />
                {client.name}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="tf-mi tf-mi-add"
              onClick={() => {
                setMenuOpen(false);
                onOpenConnect();
              }}
              data-testid="brand-switcher.add-client"
            >
              + Connect client
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
