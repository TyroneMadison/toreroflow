import { useCallback, useEffect, useState, type DragEvent as RDragEvent } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, fileUrl, type PostTargetInfo } from "../lib/api";
import { holidayFor } from "../lib/holidays";
import { PF_ID, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import PostDetailModal from "../modals/PostDetailModal";

interface CalendarScreenProps {
  onNewPost(): void;
}

type CalView = "day" | "week" | "month";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Instagram and Snapchat lean violet, TikTok and YouTube lean blue. */
const EV_CLASS: Record<Platform, "v" | "b"> = {
  instagram: "v",
  snapchat: "v",
  tiktok: "b",
  youtube: "b",
  facebook: "b",
};

const EV_DOT: Record<Platform, string> = {
  instagram: "#d62976",
  tiktok: "#25f4ee",
  youtube: "#ff4237",
  snapchat: "#ffe600",
  facebook: "#1877f2",
};

const STATUS_SUFFIX: Record<PostTargetInfo["status"], string> = {
  scheduled: "",
  publishing: " · publishing",
  posted: " · posted",
  failed: " · failed",
};

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

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function CalendarScreen({ onNewPost }: CalendarScreenProps) {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const [view, setView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [targets, setTargets] = useState<PostTargetInfo[]>([]);
  const today = new Date().toDateString();

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
      } catch (err) {
        // Polls stay silent: the rows on screen are this brand's own. The
        // first load of a mount or a range change is operator-initiated, so
        // that failure is announced.
        if (opts?.announce) toast.fail("Could not load the calendar", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedClient, view, anchor.getTime(), toast],
  );

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
      ? { outline: "1.5px dashed rgba(139,123,255,.7)", outlineOffset: -2, borderRadius: 12 }
      : undefined;

  const renderEvent = (t: PostTargetInfo) => {
    const thumb = fileUrl(t.thumbUrl);
    const movable = t.status === "scheduled";
    return (
      <div
        className={`ev ${EV_CLASS[t.platform]}`}
        key={t.id}
        title={movable ? "Click for details, drag to move" : (t.error ?? t.assetName)}
        draggable={movable}
        onDragStart={(e) => e.dataTransfer.setData("text/target", t.id)}
        onClick={() => setDetail(t)}
        style={{
          ...(t.status === "failed" ? { borderColor: "rgba(255,107,122,.5)" } : {}),
          cursor: movable ? "grab" : "pointer",
        }}
      >
        <div className="t1">
          <Pf p={PF_ID[t.platform]} size="sm" />{" "}
          {t.scheduledAt ? fmtTime(t.scheduledAt) : ""}
          {STATUS_SUFFIX[t.status]}
        </div>
        <div className="t2">{t.assetName}</div>
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

  return (
    <section className="screen active" data-screen="calendar">
      <div className="topbar">
        <div className="h">
          <h2>Content Calendar</h2>
          <p>
            {scheduledCount
              ? `${scheduledCount} ${scheduledCount === 1 ? "post" : "posts"} scheduled in view.`
              : "Nothing scheduled in this view yet."}
          </p>
        </div>
        <button className="btn ghost" onClick={onNewPost}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          New post
        </button>
      </div>
      <div className="stage">
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

        {view === "week" && (
          <div className="cal glass">
            {week.map((day, i) => {
              const events = eventsFor(day);
              return (
                <div className="col" key={i} {...dragProps(day)} style={dropStyle(day)}>
                  <div className={`colhead${day.toDateString() === today ? " today" : ""}`}>
                    <div className="dow">{DOW[i]}</div>
                    <div className="dnum">{day.getDate()}</div>
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

        {view === "day" && (
          <div className="cal glass" style={{ gridTemplateColumns: "1fr" }}>
            <div className="col" {...dragProps(anchor)} style={dropStyle(anchor)}>
              <div className={`colhead${anchor.toDateString() === today ? " today" : ""}`}>
                <div className="dow">{DOW[(anchor.getDay() + 6) % 7]}</div>
                <div className="dnum">{anchor.getDate()}</div>
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

        {view === "month" && (
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
                      <span>{day.getDate()}</span>
                    </div>
                    {holidayRow(day, true)}
                    {eventsFor(day)
                      .slice(0, 3)
                      .map((t) => {
                        const movable = t.status === "scheduled";
                        return (
                          <div
                            className="mev"
                            key={t.id}
                            title={
                              movable
                                ? `${t.assetName} - click for details, drag to move`
                                : `${t.assetName}${STATUS_SUFFIX[t.status]}`
                            }
                            draggable={movable}
                            style={{ cursor: movable ? "grab" : "pointer" }}
                            onDragStart={(e) => e.dataTransfer.setData("text/target", t.id)}
                            onClick={() => setDetail(t)}
                          >
                            <span className="d" style={{ background: EV_DOT[t.platform] }} />
                            {t.scheduledAt ? fmtTime(t.scheduledAt) : ""}
                            {STATUS_SUFFIX[t.status]}
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
          Posts are color-coded by platform; click one for details, drag a scheduled post to
          another day. Holidays appear as reminders across all views.
        </div>
      </div>

      {detail && (
        <PostDetailModal
          target={detail}
          onClose={() => setDetail(null)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}
