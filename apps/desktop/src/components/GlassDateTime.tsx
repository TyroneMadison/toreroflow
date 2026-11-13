import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { PHONE_MAX } from "../lib/phone";

interface GlassDateTimeProps {
  /** Local datetime value, "YYYY-MM-DDTHH:mm", same shape as datetime-local. */
  value: string;
  onChange(next: string): void;
  /** Earliest selectable day; past days render disabled. */
  minDate?: Date;
}

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Approximate rendered panel height, used only to choose a drop direction. */
const PANEL_HEIGHT = 330;

/** Breathing room between the panel and the edge of the window. */
const EDGE_GAP = 12;

/**
 * Below this the panel is not worth opening in that direction at all, so the
 * roomier side wins even if neither can show the whole thing.
 */
const MIN_USABLE_HEIGHT = 220;

export interface Placement {
  /** True to open above the trigger rather than below it. */
  up: boolean;
  /** How tall the panel may be before it has to scroll inside itself. */
  maxHeight: number;
}

/**
 * Which way the panel opens, and how much room it gets.
 *
 * The version this replaced only flipped upward when the whole panel fit
 * above. That is fine on a desktop and wrong on a laptop: when neither side
 * fits, it left the panel dropping downward past the bottom of the window,
 * clipped, with the last two weeks of the month unreachable. The window was
 * short, not the panel.
 *
 * So downward is still preferred, because that is what a picker normally
 * does, but when it does not fit the roomier side wins and the panel is told
 * how tall it may be. It scrolls inside itself from there.
 *
 * Pure so the three branches can be checked without a browser, since getting
 * this wrong reproduces the original bug exactly.
 */
export function choosePlacement(
  triggerTop: number,
  triggerBottom: number,
  windowHeight: number,
): Placement {
  const below = windowHeight - triggerBottom - EDGE_GAP;
  const above = triggerTop - EDGE_GAP;

  const up = below >= PANEL_HEIGHT ? false : above >= PANEL_HEIGHT ? true : above > below;
  const room = up ? above : below;
  // Floored, so a trigger jammed against an edge still opens something usable
  // and scrollable rather than a sliver nobody can read.
  return { up, maxHeight: Math.max(MIN_USABLE_HEIGHT, room) };
}

/** A phone turned sideways is at most this tall, whatever its width. */
const SHEET_MAX_HEIGHT = 500;

export type SheetMode = "none" | "portrait" | "landscape";

/**
 * Whether the picker opens as a phone sheet, and which shape.
 *
 * Anchored under its trigger, the panel only works where there is room around
 * the trigger. On a phone there is not: upright, the month and the three time
 * columns are wider than the screen and drew on top of each other; sideways,
 * the window is under 400px tall and the panel ran off the bottom with Done
 * out of reach. So on a phone the panel leaves the trigger and docks to the
 * screen instead: a bottom sheet upright, a full height side by side panel
 * sideways.
 */
export function sheetMode(width: number, height: number): SheetMode {
  if (height <= SHEET_MAX_HEIGHT && width > height) return "landscape";
  if (width <= PHONE_MAX) return "portrait";
  return "none";
}

const pad = (n: number) => n.toString().padStart(2, "0");

function toValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseValue(v: string): Date {
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Date and time picker styled to the app's glass language. Replaces the
 * native datetime-local popup, whose panel is browser chrome and cannot be
 * themed with CSS.
 */
export default function GlassDateTime({ value, onChange, minDate }: GlassDateTimeProps) {
  const selected = useMemo(() => parseValue(value), [value]);
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [viewMonth, setViewMonth] = useState(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** The panel itself, which is portalled out of the wrapper on a phone. */
  const popRef = useRef<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState<SheetMode>("none");
  const hourColRef = useRef<HTMLDivElement | null>(null);
  const minuteColRef = useRef<HTMLDivElement | null>(null);
  /**
   * How tall the panel may be, given where the trigger sits in the window.
   * Null until it has been measured, which is also the "no clamp yet" state.
   */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  const place = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const { up, maxHeight: room } = choosePlacement(r.top, r.bottom, window.innerHeight);
    setSheet(sheetMode(window.innerWidth, window.innerHeight));
    setDropUp(up);
    setMaxHeight(room);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Resizing the window while the panel is open changes how much room it
    // has, and this app is resized often. Without this the panel keeps the
    // height it was given when it opened and clips again. Turning a phone
    // fires this too, which is what swaps the sheet between its two shapes.
    const onResize = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Bring the chosen hour and minute into view instead of leaving both columns at the top.
  useEffect(() => {
    if (!open) return;
    for (const col of [hourColRef.current, minuteColRef.current]) {
      const el = col?.querySelector<HTMLElement>(".on");
      if (el && col) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.clientHeight / 2;
    }
  }, [open, sheet]);

  const commit = (next: Date) => onChange(toValue(next));

  /**
   * Picking a day keeps the chosen time, unless that lands in the past.
   *
   * Selecting tomorrow at 9am and then coming back to today would otherwise
   * commit 9am this morning: a moment the hour column now refuses to offer,
   * arrived at through the calendar instead. Snapping to the floor keeps the
   * two halves of the picker telling the same story.
   */
  const pickDay = (day: number) => {
    const next = new Date(selected);
    next.setFullYear(viewMonth.getFullYear(), viewMonth.getMonth(), day);
    if (minDate && next < minDate) {
      const floorAt = new Date(minDate);
      next.setHours(floorAt.getHours(), floorAt.getMinutes(), 0, 0);
    }
    commit(next);
  };

  const hour12 = selected.getHours() % 12 === 0 ? 12 : selected.getHours() % 12;
  const isPm = selected.getHours() >= 12;

  const setHour12 = (h: number) => {
    const next = new Date(selected);
    next.setHours((h % 12) + (isPm ? 12 : 0));
    commit(next);
  };
  const setMinute = (m: number) => {
    const next = new Date(selected);
    next.setMinutes(m);
    commit(next);
  };
  const setMeridiem = (pm: boolean) => {
    const next = new Date(selected);
    next.setHours((selected.getHours() % 12) + (pm ? 12 : 0));
    commit(next);
  };

  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(
    viewMonth.getFullYear(),
    viewMonth.getMonth() + 1,
    0,
  ).getDate();

  /*
   * The earliest selectable moment, kept to the minute rather than flattened
   * to the start of its day.
   *
   * This used to read setHours(0,0,0,0), which made the floor "today" instead
   * of "now": every past day was greyed out and every past hour of today was
   * offered. Picking 9am at 4pm produced a scheduled post the worker publishes
   * the instant it is queued, which is how a video goes out unannounced.
   */
  const floor = minDate ? new Date(minDate) : null;
  /** The whole day is gone when even its last minute is behind the floor. */
  const dayIsPast = (d: Date): boolean => {
    if (!floor) return false;
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return end < floor;
  };
  /** An hour on the selected day, judged by its last minute. */
  const hourIsPast = (h24: number): boolean => {
    if (!floor) return false;
    const end = new Date(selected);
    end.setHours(h24, 59, 59, 999);
    return end < floor;
  };
  const minuteIsPast = (m: number): boolean => {
    if (!floor) return false;
    const at = new Date(selected);
    at.setMinutes(m, 59, 999);
    return at < floor;
  };
  /** A meridiem is gone only when all six of its hours are. */
  const meridiemIsPast = (pm: boolean): boolean =>
    Array.from({ length: 12 }, (_, i) => (i % 12) + (pm ? 12 : 0)).every(hourIsPast);

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const label = selected.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  /*
   * A sheet is portalled to the body. Left inside the modal it is positioned
   * against the modal's glass, not the screen, because backdrop-filter makes
   * an element the containing block of its fixed children.
   */
  const portal = (node: ReactElement) =>
    sheet === "none" ? node : createPortal(node, document.body);

  return (
    <div className="gdt" ref={wrapRef}>
      <button
        type="button"
        className="gdt-trigger field-in"
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
      >
        <span>{label}</span>
        <svg className="gdt-cal">
          <use href="#i-cal" />
        </svg>
      </button>

      {open && sheet !== "none" &&
        createPortal(
          <div className="gdt-scrim" onClick={() => setOpen(false)} />,
          document.body,
        )}
      {open && portal(
        <div
          ref={popRef}
          className={
            sheet === "none"
              ? `gdt-pop glass${dropUp ? " up" : ""}`
              : `gdt-pop glass gdt-sheet ${sheet}`
          }
          style={sheet === "none" && maxHeight !== null ? { maxHeight } : undefined}
          role="dialog"
          aria-label="Pick a date and time"
        >
          <div className="gdt-cols">
            <div className="gdt-cal-side">
              <div className="gdt-head">
                <b>
                  {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
                </b>
                <div className="gdt-nav">
                  <button
                    type="button"
                    onClick={() =>
                      setViewMonth(
                        new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1),
                      )
                    }
                    aria-label="Previous month"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setViewMonth(
                        new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
                      )
                    }
                    aria-label="Next month"
                  >
                    ›
                  </button>
                </div>
              </div>

              <div className="gdt-grid gdt-dow">
                {DAY_LABELS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div className="gdt-grid">
                {cells.map((day, i) => {
                  if (day === null) return <span key={`b${i}`} className="gdt-blank" />;
                  const thisDay = new Date(
                    viewMonth.getFullYear(),
                    viewMonth.getMonth(),
                    day,
                  );
                  const disabled = dayIsPast(thisDay);
                  return (
                    <button
                      type="button"
                      key={day}
                      className={`gdt-day${sameDay(thisDay, selected) ? " on" : ""}${
                        sameDay(thisDay, new Date()) ? " today" : ""
                      }`}
                      disabled={disabled}
                      onClick={() => pickDay(day)}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="gdt-time">
              <div className="gdt-col" ref={hourColRef}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                  <button
                    type="button"
                    key={h}
                    className={h === hour12 ? "on" : undefined}
                    disabled={hourIsPast((h % 12) + (isPm ? 12 : 0))}
                    onClick={() => setHour12(h)}
                  >
                    {pad(h)}
                  </button>
                ))}
              </div>
              <div className="gdt-col" ref={minuteColRef}>
                {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={m === selected.getMinutes() ? "on" : undefined}
                    disabled={minuteIsPast(m)}
                    onClick={() => setMinute(m)}
                  >
                    {pad(m)}
                  </button>
                ))}
              </div>
              <div className="gdt-col gdt-mer">
                <button
                  type="button"
                  className={!isPm ? "on" : undefined}
                  disabled={meridiemIsPast(false)}
                  onClick={() => setMeridiem(false)}
                >
                  AM
                </button>
                <button
                  type="button"
                  className={isPm ? "on" : undefined}
                  disabled={meridiemIsPast(true)}
                  onClick={() => setMeridiem(true)}
                >
                  PM
                </button>
              </div>
            </div>
          </div>

          <div className="gdt-foot">
            <span
              className="link"
              onClick={() => {
                const now = new Date(Date.now() + 10 * 60_000);
                setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                commit(now);
              }}
            >
              In 10 minutes
            </span>
            <span className="link" onClick={() => setOpen(false)}>
              Done
            </span>
          </div>
        </div>,
      )}
    </div>
  );
}
