import { useCallback, useEffect, useState, type DragEvent as RDragEvent } from "react";
import BestTimes from "../components/BestTimes";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, fileUrl, type ClientPost, type PostTargetInfo } from "../lib/api";
import { scheduleTimeError } from "@toreroflow/core";
import { holidayFor } from "../lib/holidays";
import { PF_ID } from "../lib/platforms";
import { canMove, POST_STATUS, type PostStatus, type StatusMeta } from "../lib/postStatus";
import { useAppState } from "../state/AppState";
import PostDetailModal from "../modals/PostDetailModal";
import { Empty, ErrorState, Loading } from "../components/states";
import { useIsPhone } from "../lib/phone";
import { navigate } from "../lib/routes";
import { dayKey, isOwnBrand, xPostedLabel } from "../lib/xPosted";

interface CalendarScreenProps {
  onNewPost(): void;
}

type CalView = "day" | "week" | "month";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ICON_HREF: Record<StatusMeta["icon"], string> = {
  lock: "#i-lock",
  unlock: "#i-unlock",
  alert: "#i-alert",
};

/**
 * The status dot, in every view and in the legend.
 *
 * Colour is never the only carrier: the label goes to screen readers here,
 * and the card's `title` says it in plain words for everyone else.
 */
function StatusDot({ status, decorative }: { status: PostStatus; decorative?: boolean }) {
  const meta = POST_STATUS[status];
  const cls = `stdot st-${status}${meta.pulses ? " pulse" : ""}`;
  // In the legend the words sit right beside it, so announcing the label
  // again would just read the status twice.
  if (decorative) return <span className={cls} aria-hidden="true" />;
  return <span className={cls} role="img" aria-label={meta.label} />;
}

/** Padlock, open padlock or warning triangle, following the drag rule. */
function StatusIcon({ status }: { status: PostStatus }) {
  return (
    <svg className={`sticon st-${status}`} aria-hidden="true">
      <use href={ICON_HREF[POST_STATUS[status].icon]} />
    </svg>
  );
}

const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const mondayOf = (d: Date): Date => {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

/** Simple Icons' X mark. */
const X_LOGO =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";

/** "Posted to X" tick beside a day's date. A record only: nothing is posted. */
function XPostedCheck({ day, checked, onToggle }: { day: Date; checked: boolean; onToggle(): void }) {
  return (
    <label className={`xchk${checked ? " on" : ""}`} title={checked ? "Posted to X (click to clear)" : "Mark as posted to X"}>
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={xPostedLabel(day)} />
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={X_LOGO} />
      </svg>
    </label>
  );
}

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function CalendarScreen({ onNewPost }: CalendarScreenProps) {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const isPhone = useIsPhone();
  const [view, setView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [targets, setTargets] = useState<PostTargetInfo[]>([]);
  // The screen remounts per brand, so the skeleton shows once per brand and
  // never again on polls or range changes.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Feeds the best-times strip. Loaded once per brand, not polled: it is
  // built from published history, which moves daily, not while you watch.
  const [bestTimePosts, setBestTimePosts] = useState<ClientPost[]>([]);
  const today = new Date().toDateString();

  useEffect(() => {
    setBestTimePosts([]);
    if (!selectedClient) return;
    let cancelled = false;
    api
      .get<{ posts: ClientPost[] }>(`/clients/${selectedClient.id}/analytics/posts`)
      .then((r) => {
        if (!cancelled) setBestTimePosts(r.posts);
      })
      .catch(() => {
        // The strip simply does not render. Scheduling works fine without it,
        // and the calendar failing to load is the error worth hearing about.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient]);

  // Visible range per view.
  let rangeStart: Date;
  let rangeEnd: Date;
  if (view === "day") {
    rangeStart = startOfDay(anchor);
    rangeEnd = new Date(rangeStart);
    rangeEnd.setHours(23, 59, 59, 999);
  } else if (view === "week") {
    rangeStart = mondayOf(anchor);
    rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeStart.getDate() + 6);
    rangeEnd.setHours(23, 59, 59, 999);
  } else {
    rangeStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    rangeEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const load = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setTargets([]);
        return;
      }
      try {
        setTargets(
          await api.get<PostTargetInfo[]>(
            `/clients/${selectedClient.id}/posts?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
          ),
        );
        setLoaded(true);
        setLoadError(false);
      } catch {
        // Polls stay silent: the rows on screen are this brand's own. The
        // first load of a mount or a range change is operator-initiated, so
        // that failure shows as the screen's error state.
        if (opts?.announce) setLoadError(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedClient, view, anchor.getTime()],
  );

  /*
   * Tyrone's own brand only: which days he posted to X by hand. Loaded per
   * range, toggled optimistically, put back if the save fails.
   */
  const ownBrand = isOwnBrand(selectedClient?.name);
  const [xPosted, setXPosted] = useState<Set<string>>(new Set());
  const fromKey = dayKey(rangeStart);
  const toKey = dayKey(rangeEnd);
  useEffect(() => {
    setXPosted(new Set());
    if (!selectedClient || !ownBrand) return;
    let cancelled = false;
    api
      .get<{ dates: string[] }>(`/brands/${selectedClient.id}/x-posted?from=${fromKey}&to=${toKey}`)
      .then((r) => {
        if (!cancelled) setXPosted(new Set(r.dates));
      })
      .catch(() => {
        // The ticks stay blank; the calendar itself is unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient, ownBrand, fromKey, toKey]);

  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const toggleX = async (day: Date) => {
    if (!selectedClient) return;
    const key = dayKey(day);
    const posted = !xPosted.has(key);
    setXPosted((s) => flip(s, key));
    try {
      await api.put(`/brands/${selectedClient.id}/x-posted/${key}`, { posted });
    } catch (err) {
      setXPosted((s) => flip(s, key));
      toast.fail("Could not save the X tick", err);
    }
  };
  const xCheck = (day: Date) =>
    ownBrand ? <XPostedCheck day={day} checked={xPosted.has(dayKey(day))} onToggle={() => void toggleX(day)} /> : null;
  /** The date, with the X tick beside it on the own brand only. */
  const dnum = (day: Date) =>
    ownBrand ? (
      <div className="dnumrow">
        <div className="dnum">{day.getDate()}</div>
        {xCheck(day)}
      </div>
    ) : (
      <div className="dnum">{day.getDate()}</div>
    );

  const state = !selectedClient ? "empty" : loadError ? "error" : loaded ? "ready" : "loading";

  useEffect(() => {
    void load({ announce: true });
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const step = (dir: 1 | -1) => {
    setAnchor((prev) => {
      const next = new Date(prev);
      if (view === "day") next.setDate(next.getDate() + dir);
      else if (view === "week") next.setDate(next.getDate() + dir * 7);
      else next.setMonth(next.getMonth() + dir);
      return startOfDay(next);
    });
  };

  const eventsFor = (day: Date) =>
    targets.filter(
      (t) => t.scheduledAt && new Date(t.scheduledAt).toDateString() === day.toDateString(),
    );

  const scheduledCount = targets.filter(
    (t) => t.status === "scheduled" || t.status === "publishing",
  ).length;

  const rangeLabel =
    view === "day"
      ? anchor.toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : view === "week"
        ? `${MONTHS[rangeStart.getMonth()].slice(0, 3)} ${rangeStart.getDate()} to ${MONTHS[rangeEnd.getMonth()].slice(0, 3)} ${rangeEnd.getDate()}, ${rangeEnd.getFullYear()}`
        : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;

  const holidayRow = (day: Date, compact = false) => {
    const h = holidayFor(day);
    if (!h) return null;
    return (
      <div className={compact ? "mhol" : "hol"} title={h.name}>
        <img src={h.emoji} alt="" /> {h.name}
      </div>
    );
  };

  const [dropKey, setDropKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<PostTargetInfo | null>(null);

  /** Drop handler: move the dragged target to `day`, keeping its time. */
  const dropOn = async (e: RDragEvent, day: Date) => {
    e.preventDefault();
    setDropKey(null);
    const id = e.dataTransfer.getData("text/target");
    const target = targets.find((t) => t.id === id);
    if (!target?.scheduledAt) return;
    const oldWhen = new Date(target.scheduledAt);
    const when = new Date(day);
    when.setHours(oldWhen.getHours(), oldWhen.getMinutes(), 0, 0);
    // Dropping back onto the same day would be a pointless round trip.
    if (when.getTime() === oldWhen.getTime()) return;
    /*
     * Dragging is the third door into a scheduled time and the only one with
     * no picker in front of it, so the same rule is applied here rather than
     * left to the server's refusal. The card snaps back either way; saying why
     * is the difference between a rule and a glitch.
     */
    const whenError = scheduleTimeError(when);
    if (whenError) {
      toast.error(whenError);
      return;
    }
    try {
      await api.patch(`/posts/targets/${id}/reschedule`, {
        scheduledAt: when.toISOString(),
      });
    } catch (err) {
      // The reload snaps the card back to its old day, which on its own is
      // indistinguishable from the drop never registering.
      toast.fail("Could not reschedule the post", err);
    }
    void load();
  };

  const dragProps = (day: Date) => ({
    onDragOver: (e: RDragEvent) => {
      e.preventDefault();
      setDropKey(day.toDateString());
    },
    onDragLeave: () => setDropKey((k) => (k === day.toDateString() ? null : k)),
    onDrop: (e: RDragEvent) => void dropOn(e, day),
  });

  const dropStyle = (day: Date) =>
    dropKey === day.toDateString()
      ? { outline: "1.5px dashed rgba(255,111,97,.7)", outlineOffset: -2, borderRadius: 12 }
      : undefined;

  /** Plain words for the hover, since the dot and the padlock are shapes. */
  const evTitle = (t: PostTargetInfo): string => {
    const meta = POST_STATUS[t.status];
    const kind = t.assetKind === "carousel" ? `carousel of ${t.slideCount || "several"} - ` : "";
    if (t.status === "failed") return `${kind}${t.assetName} - failed: ${t.error ?? "unknown error"}`;
    if (meta.movable) return `${t.assetName} - click for details, drag to move`;
    return `${t.assetName} - ${meta.label.toLowerCase()}, cannot be moved`;
  };

  const renderEvent = (t: PostTargetInfo) => {
    const thumb = fileUrl(t.thumbUrl);
    const movable = canMove(t.status);
    const when = t.scheduledAt ? fmtTime(t.scheduledAt) : "";
    const label = POST_STATUS[t.status].label;
    return (
      <div
        className={`ev st-${t.status}`}
        key={t.id}
        title={evTitle(t)}
        draggable={movable}
        onDragStart={(e) => e.dataTransfer.setData("text/target", t.id)}
        onClick={() => setDetail(t)}
        style={{ cursor: movable ? "grab" : "pointer" }}
      >
        <div className="t1">
          <StatusDot status={t.status} />
          <Pf p={PF_ID[t.platform]} size="sm" />
          <span className="evwhen">{when ? `${when} · ${label}` : label}</span>
          <StatusIcon status={t.status} />
        </div>
        <div className="t2">
          {t.assetKind === "carousel" && (
            <span className="qcarousel" title="A carousel of images">
              ▤ {t.slideCount || ""}
            </span>
          )}
          {t.assetName}
        </div>
        {thumb && <div className="evthumb" style={{ background: `url(${thumb}) center/cover` }} />}
      </div>
    );
  };

  /* month grid cells: leading blanks + days */
  const monthCells: Array<Date | null> = [];
  if (view === "month") {
    const lead = (new Date(anchor.getFullYear(), anchor.getMonth(), 1).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) monthCells.push(null);
    for (let d = 1; d <= rangeEnd.getDate(); d++) {
      monthCells.push(new Date(anchor.getFullYear(), anchor.getMonth(), d));
    }
  }

  const week = view === "week"
    ? DOW.map((_, i) => {
        const d = new Date(rangeStart);
        d.setDate(rangeStart.getDate() + i);
        return d;
      })
    : [];

  const detailModal = detail && (
    <PostDetailModal
      target={detail}
      // Same local-day rule the grid uses to place cards, so the button's
      // count is exactly the cards in that day's cell.
      dayTargets={
        detail.scheduledAt
          ? targets.filter(
              (t) =>
                t.scheduledAt &&
                new Date(t.scheduledAt).toDateString() ===
                  new Date(detail.scheduledAt!).toDateString(),
            )
          : undefined
      }
      onClose={() => setDetail(null)}
      onChanged={() => void load()}
    />
  );

  /*
   * Phones (Direction C): the week strip and the chosen day's agenda sit above
   * the fold, the views are chips, and a failed post carries Retry (the detail
   * sheet, where retry lives) and Reconnect (Settings, Connected Accounts)
   * inline. Dragging has no phone equivalent; Reschedule is in the detail.
   */
  if (isPhone) {
    const strip = view === "month" ? [] : DOW.map((_, i) => {
      const d = mondayOf(anchor);
      d.setDate(d.getDate() + i);
      return d;
    });
    const dayEvents = eventsFor(anchor).sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? ""));
    const dayButton = (day: Date, key: string | number, label?: string) => {
      const n = eventsFor(day).length;
      const on = day.toDateString() === anchor.toDateString();
      return (
        <button
          type="button"
          key={key}
          className={`mcal-day${on ? " on" : ""}${day.toDateString() === today ? " today" : ""}`}
          aria-pressed={on}
          aria-label={`${day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}, ${n} ${n === 1 ? "post" : "posts"}`}
          onClick={() => setAnchor(startOfDay(day))}
        >
          {label && <small>{label}</small>}
          <b>{day.getDate()}</b>
          <span className="mcal-dots" aria-hidden="true">
            {Array.from({ length: Math.min(n, 3) }, (_, k) => <i key={k} />)}
          </span>
        </button>
      );
    };
    return (
      <section className="screen active mcal" data-screen="calendar" data-state={state}>
        <div className="mcal-head">
          <div className="mcal-titles">
            <div className="mcal-eyebrow">Calendar · {selectedClient?.name ?? "No brand"}</div>
            <h2 className="mcal-title">
              {view === "day"
                ? anchor.toLocaleDateString([], { month: "long", day: "numeric" })
                : `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`}
            </h2>
          </div>
          <div className="mcal-nav">
            <button type="button" className="mcal-ib" aria-label="Previous" onClick={() => step(-1)}>
              <svg aria-hidden="true" style={{ transform: "rotate(90deg)" }}><use href="#i-chev" /></svg>
            </button>
            <button type="button" className="mcal-ib" aria-label="Next" onClick={() => step(1)}>
              <svg aria-hidden="true" style={{ transform: "rotate(-90deg)" }}><use href="#i-chev" /></svg>
            </button>
          </div>
        </div>
        <div className="mcal-views" role="tablist" aria-label="Calendar view">
          {(["day", "week", "month"] as CalView[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
          <button type="button" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
        </div>

        {state === "empty" && <Empty screen="calendar" title="No brand selected" hint="Pick a brand at the top to see its calendar." />}
        {state === "loading" && <Loading screen="calendar" label="Loading the calendar" />}
        {state === "error" && (
          <ErrorState
            screen="calendar"
            message="Could not load the calendar. Check that the API is online, then try again."
            onRetry={() => {
              setLoadError(false);
              void load({ announce: true });
            }}
          />
        )}

        {state === "ready" && (
          <>
            {view === "week" && (
              <div className="mcal-strip">{strip.map((d, i) => dayButton(d, i, DOW[i]![0]))}</div>
            )}
            {view === "month" && (
              <div className="mcal-month">
                {DOW.map((d) => <span key={d} className="mcal-dow">{d[0]}</span>)}
                {monthCells.map((d, i) => (d ? dayButton(d, i) : <span key={`b${i}`} />))}
              </div>
            )}
            <div className="mcal-dayhead">
              <h3>{anchor.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</h3>
              <span className="tf-lbl">{dayEvents.length} {dayEvents.length === 1 ? "post" : "posts"}</span>
            </div>
            {holidayRow(anchor)}
            <div className="mcal-agenda card glass">
              {dayEvents.length === 0 && (
                <div className="mcal-none">
                  Nothing on this day yet.
                  <button type="button" className="btn ghost" onClick={onNewPost}>+ Add post</button>
                </div>
              )}
              {dayEvents.map((t) => {
                const [hm, ap] = (t.scheduledAt ? fmtTime(t.scheduledAt) : "").split(" ");
                const reconnect = t.status === "failed" && /token|auth|expired|reconnect|permission/i.test(t.error ?? "");
                return (
                  <div className={`mcal-item st-${t.status}`} key={t.id}>
                    <div className="mcal-time"><b>{hm}</b><small>{ap}</small></div>
                    <div className="mcal-body">
                      <div className="mcal-name"><Pf p={PF_ID[t.platform]} size="sm" /> <span>{t.assetName}</span></div>
                      <div className={`mcal-st st-${t.status}`}>
                        <StatusIcon status={t.status} />
                        {POST_STATUS[t.status].label}
                        {t.status === "failed" && t.error ? ` · ${t.error}` : canMove(t.status) ? " · can move" : ""}
                      </div>
                      <div className="mcal-acts">
                        {t.status === "failed" ? (
                          <>
                            <button type="button" className="btn" onClick={() => setDetail(t)}>Retry</button>
                            {reconnect && (
                              <button type="button" className="btn ghost" onClick={() => navigate("settings", "accounts")}>Reconnect</button>
                            )}
                          </>
                        ) : (
                          <button type="button" className="btn ghost" onClick={() => setDetail(t)}>
                            {canMove(t.status) ? "Reschedule" : "Details"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="mb-actionbar">
          <button type="button" className="tf-btn pri" onClick={onNewPost} data-testid="calendar.new-post">
            <svg aria-hidden="true"><use href="#i-plus" /></svg>
            New post
          </button>
        </div>
        {detailModal}
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="calendar" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Content Calendar</h2>
          <p>
            {scheduledCount
              ? `${scheduledCount} ${scheduledCount === 1 ? "post" : "posts"} scheduled in view.`
              : "Nothing scheduled in this view yet."}
          </p>
        </div>
        <button className="btn ghost" onClick={onNewPost} data-testid="calendar.new-post">
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          New post
        </button>
      </div>
      <div className="stage">
        {/* The same widget the upload screen carries, laid flat so the week
            still fits on screen below it. Hidden entirely when there is no
            history: an empty strip would just push the calendar down. */}
        {bestTimePosts.some((p) => p.byPlatform.some((b) => b.views > 0)) && (
          <div className="card glass btwide">
            <div className="btwide-head">
              <h3>
                <svg
                  style={{ width: 16, height: 16, stroke: "var(--v)", fill: "none", strokeWidth: 2 }}
                  viewBox="0 0 24 24"
                >
                  <use href="#i-bolt" />
                </svg>{" "}
                Best times to post
              </h3>
              <div className="sub">
                Measured from {selectedClient?.name ?? "this brand"}'s own results
              </div>
            </div>
            <BestTimes posts={bestTimePosts} />
          </div>
        )}

        <div className="calbar">
          <div className="seg">
            {(["day", "week", "month"] as CalView[]).map((v) => (
              <span
                key={v}
                className={view === v ? "on" : ""}
                onClick={() => setView(v)}
              >
                {v[0]!.toUpperCase() + v.slice(1)}
              </span>
            ))}
          </div>
          <div className="calnav">
            <div className="iconbtn" onClick={() => step(-1)} title="Previous">
              <svg style={{ transform: "rotate(90deg)" }}>
                <use href="#i-chev" />
              </svg>
            </div>
            <div className="iconbtn" onClick={() => step(1)} title="Next">
              <svg style={{ transform: "rotate(-90deg)" }}>
                <use href="#i-chev" />
              </svg>
            </div>
          </div>
          <div
            className="filterchip"
            onClick={() => setAnchor(startOfDay(new Date()))}
            title="Jump to today"
          >
            Today
          </div>
          <div className="filterchip" style={{ opacity: 0.8 }}>
            <span className="d" style={{ background: "var(--v)" }} />{" "}
            {selectedClient?.name ?? "No brand selected"}
          </div>
          <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--txt-2)" }}>
            {rangeLabel}
          </div>
        </div>

        {/* Always on, in every view: the key to the dots and the padlocks. */}
        <div className="callegend">
          {(Object.keys(POST_STATUS) as PostStatus[]).map((s) => (
            <span className="litem" key={s}>
              <StatusDot status={s} decorative />
              <StatusIcon status={s} />
              {POST_STATUS[s].label}<span className="lhint">, {POST_STATUS[s].hint}</span>
            </span>
          ))}
        </div>

        {state === "empty" && (
          <Empty
            screen="calendar"
            title="No brand selected"
            hint="Pick a brand in the dock to see its calendar."
          />
        )}
        {state === "loading" && <Loading screen="calendar" label="Loading the calendar" />}
        {state === "error" && (
          <ErrorState
            screen="calendar"
            message="Could not load the calendar. Check that the API is online, then try again."
            onRetry={() => {
              setLoadError(false);
              void load({ announce: true });
            }}
          />
        )}

        {state === "ready" && view === "week" && (
          <div className="cal glass">
            {week.map((day, i) => {
              const events = eventsFor(day);
              return (
                <div className="col" key={i} {...dragProps(day)} style={dropStyle(day)}>
                  <div className={`colhead${day.toDateString() === today ? " today" : ""}`}>
                    <div className="dow">{DOW[i]}</div>
                    {dnum(day)}
                    {holidayRow(day)}
                  </div>
                  <div className="slotwrap">
                    {events.map(renderEvent)}
                    {events.length === 0 && (
                      <div className="ghost-ev" onClick={onNewPost}>
                        + Add post
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {state === "ready" && view === "day" && (
          <div className="cal glass" style={{ gridTemplateColumns: "1fr" }}>
            <div className="col" {...dragProps(anchor)} style={dropStyle(anchor)}>
              <div className={`colhead${anchor.toDateString() === today ? " today" : ""}`}>
                <div className="dow">{DOW[(anchor.getDay() + 6) % 7]}</div>
                {dnum(anchor)}
                {holidayRow(anchor)}
              </div>
              <div className="slotwrap" style={{ maxWidth: 460, margin: "0 auto", width: "100%" }}>
                {eventsFor(anchor).map(renderEvent)}
                {eventsFor(anchor).length === 0 && (
                  <div className="ghost-ev" onClick={onNewPost}>
                    + Add post
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {state === "ready" && view === "month" && (
          <div className="cal glass" style={{ display: "block" }}>
            <div className="mhead">
              {DOW.map((d) => (
                <div key={d} className="dow">
                  {d}
                </div>
              ))}
            </div>
            <div className="mgrid">
              {monthCells.map((day, i) =>
                day === null ? (
                  <div className="mcell dim" key={`blank-${i}`} />
                ) : (
                  <div
                    className={`mcell${day.toDateString() === today ? " today" : ""}`}
                    key={day.getDate()}
                    {...dragProps(day)}
                    style={dropStyle(day)}
                  >
                    <div className="mnum">
                      {xCheck(day)}
                      <span>{day.getDate()}</span>
                    </div>
                    {holidayRow(day, true)}
                    {eventsFor(day)
                      .slice(0, 3)
                      .map((t) => {
                        const movable = canMove(t.status);
                        return (
                          <div
                            className={`mev st-${t.status}`}
                            key={t.id}
                            title={evTitle(t)}
                            draggable={movable}
                            style={{ cursor: movable ? "grab" : "pointer" }}
                            onDragStart={(e) => e.dataTransfer.setData("text/target", t.id)}
                            onClick={() => setDetail(t)}
                          >
                            <StatusDot status={t.status} />
                            <Pf p={PF_ID[t.platform]} size="sm" />
                            <span className="evwhen">
                              {t.scheduledAt ? fmtTime(t.scheduledAt) : ""}
                            </span>
                            <StatusIcon status={t.status} />
                          </div>
                        );
                      })}
                    {eventsFor(day).length > 3 && (
                      <div className="mhol">+{eventsFor(day).length - 3} more</div>
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        )}

        <div className="note">
          The dot and the padlock show where a post stands; click one for details, and drag a
          scheduled post to another day. Anything already posted or going out now is locked.
          Holidays appear as reminders across all views.
        </div>
      </div>

      {detailModal}
    </section>
  );
}
