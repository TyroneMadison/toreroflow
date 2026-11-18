import { useCallback, useEffect, useRef, useState, type DragEvent as RDragEvent } from "react";
import BestTimes from "../components/BestTimes";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, fileUrl, type ClientPost, type PostTargetInfo } from "../lib/api";
import { scheduleTimeError } from "@toreroflow/core";
import { holidayFor } from "../lib/holidays";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";
import { POST_STATUS, type PostStatus, type StatusMeta } from "../lib/postStatus";
import {
  dragMoves,
  groupByPost,
  groupMovable,
  groupStatus,
  otherTimes,
  targetTime,
  type PostGroup,
} from "../lib/postGroups";
import { useAppState } from "../state/AppState";
import PostDetailModal from "../modals/PostDetailModal";
import { Empty, ErrorState, Loading } from "../components/states";
import { useIsPhone } from "../lib/phone";
import { navigate } from "../lib/routes";
import { dayKey, isOwnBrand, xPostedLabel } from "../lib/xPosted";
import SwipeRow from "../components/mobile/SwipeRow";
import ConfirmSheet from "../components/mobile/ConfirmSheet";

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

const platformName = (t: PostTargetInfo) =>
  `${PLATFORM_LABELS[t.platform]}${t.accountHandle ? ` @${t.accountHandle.replace(/^@/, "")}` : ""}`;

/** "TikTok and Instagram", for toasts. */
const platformList = (ts: PostTargetInfo[]) => {
  const names = [...new Set(ts.map((t) => PLATFORM_LABELS[t.platform]))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
};

/**
 * One tile per platform the post goes to, each marked with where that
 * platform stands: a check once posted, red when it failed, a pulse while it
 * goes out. Colour is never the only carrier: each tile names its platform,
 * status and time to screen readers and on hover.
 */
function PlatformIcons({ group }: { group: PostGroup }) {
  return (
    <span className="pfstrip">
      {group.targets.map((t) => {
        const words = `${platformName(t)}: ${POST_STATUS[t.status].label}, ${targetTime(t, group.lead)}${t.trial ? ", trial reel" : ""}`;
        return (
          <span key={t.id} className={`pfmark st-${t.status}${t.trial ? " trial" : ""}`} role="img" aria-label={words} title={words}>
            <Pf p={PF_ID[t.platform]} size="sm" />
          </span>
        );
      })}
    </span>
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

/**
 * Pause uploads / Continue uploads for one brand. Shows pause while posting
 * and play while paused; the two bars morph into the play triangle.
 */
function PauseToggle({ brand, paused, busy, onToggle }: { brand: string; paused: boolean; busy: boolean; onToggle(): void }) {
  const label = paused ? `Continue uploads for ${brand}` : `Pause uploads for ${brand}`;
  return (
    <button
      type="button"
      className={`pausetgl${paused ? " on" : ""}`}
      aria-pressed={paused}
      aria-label={label}
      title={paused ? `${brand} uploads are paused. Click to continue; held posts move forward.` : `Pause uploads for ${brand}. Scheduled posts are held, not deleted.`}
      disabled={busy}
      onClick={onToggle}
      data-testid="calendar.pause"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="pz-l" />
        <path className="pz-r" />
      </svg>
      <span>{paused ? "Paused" : "Uploads on"}</span>
    </button>
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

  /* Pause uploads: held on the server, the calendar just shows and flips it. */
  const [pausedAt, setPausedAt] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  useEffect(() => {
    setPausedAt(null);
    if (!selectedClient) return;
    let cancelled = false;
    api
      .get<{ pausedAt: string | null }>(`/brands/${selectedClient.id}/pause`)
      .then((r) => {
        if (!cancelled) setPausedAt(r.pausedAt);
      })
      .catch(() => {
        // Shown as posting; the worker still holds a paused brand either way.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient]);
  const paused = pausedAt !== null;
  const togglePause = async () => {
    if (!selectedClient) return;
    setPauseBusy(true);
    try {
      if (paused) {
        const r = await api.post<{ moved: number; held: number; from: string | null }>(`/brands/${selectedClient.id}/resume`, {});
        setPausedAt(null);
        toast.success(
          r.moved
            ? `Uploads continue. Moved ${r.moved} ${r.moved === 1 ? "post" : "posts"}, the first now ${new Date(r.from!).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
            : "Uploads continue. Nothing needed to move.",
        );
      } else {
        const r = await api.post<{ pausedAt: string; held?: number }>(`/brands/${selectedClient.id}/pause`, {});
        setPausedAt(r.pausedAt);
        toast.info(`Uploads paused for ${selectedClient.name}. ${r.held ?? 0} scheduled ${r.held === 1 ? "post is" : "posts are"} held.`);
      }
    } catch (err) {
      toast.fail(paused ? "Could not continue uploads" : "Could not pause uploads", err);
    } finally {
      setPauseBusy(false);
    }
    void load();
  };
  /** A post of a paused brand with a platform still waiting: held, shown dimmed with a badge. */
  const isHeld = (g: PostGroup) => paused && g.targets.some((t) => t.status === "scheduled");
  const heldBadge = <span className="heldbadge">Paused</span>;
  const pauseToggle = selectedClient && (
    <PauseToggle brand={selectedClient.name} paused={paused} busy={pauseBusy} onToggle={() => void togglePause()} />
  );
  const pauseBanner = paused && selectedClient && (
    <div className="pausebar" role="status">
      <b>Uploads paused</b> for {selectedClient.name} since{" "}
      {new Date(pausedAt!).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.
      Scheduled posts are held. Continue moves them forward so the first lands on the day you resume.
    </div>
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

  /** One card per post, each at its earliest time in the visible range. */
  const groups = groupByPost(targets, { from: rangeStart, to: rangeEnd });
  const eventsFor = (day: Date) =>
    groups.filter((g) => new Date(g.lead.scheduledAt!).toDateString() === day.toDateString());

  const scheduledCount = groups.filter((g) =>
    g.targets.some((t) => t.status === "scheduled" || t.status === "publishing"),
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
  /** The open details panel: the post, and the platform it opens on. */
  const [detail, setDetail] = useState<{ group: PostGroup; focus: PostTargetInfo } | null>(null);
  /** Phone: a long-pressed card's menu, a post being moved to a tapped day, the pause confirm. */
  const [menuFor, setMenuFor] = useState<PostGroup | null>(null);
  const [moving, setMoving] = useState<PostGroup | null>(null);
  const [askPause, setAskPause] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const swipeX = useRef<number | null>(null);
  const suppressClick = useRef(false);
  /** Opens a card's panel on the given platform, else its first failure, else its first time. */
  const openCard = (g: PostGroup, focus?: PostTargetInfo) =>
    setDetail({ group: g, focus: focus ?? g.targets.find((t) => t.status === "failed") ?? g.lead });

  /**
   * Drop handler: move every platform of the dragged post that can still move
   * by the same number of days, each keeping its own time.
   */
  const dropOn = async (e: RDragEvent, day: Date) => {
    e.preventDefault();
    setDropKey(null);
    const group = groups.find((g) => g.postId === e.dataTransfer.getData("text/post"));
    if (!group) return;
    await moveGroup(group, day);
  };

  /** Moves every platform of a post that can still move to `day`, each keeping its own time. */
  const moveGroup = async (group: PostGroup, day: Date) => {
    // Dropping back onto the same day would be a pointless round trip.
    const moves = dragMoves(group, day);
    if (moves.length === 0) return;
    /*
     * Dragging is the third door into a scheduled time and the only one with
     * no picker in front of it, so the same rule is applied here rather than
     * left to the server's refusal, and to every platform before any moves,
     * so a drop never half lands. The card snaps back either way; saying why
     * is the difference between a rule and a glitch.
     */
    const whenError = moves.map((m) => scheduleTimeError(m.when)).find(Boolean);
    if (whenError) {
      toast.error(whenError);
      return;
    }
    const refused: PostTargetInfo[] = [];
    let lastError: unknown = null;
    for (const m of moves) {
      try {
        await api.patch(`/posts/targets/${m.target.id}/reschedule`, { scheduledAt: m.when.toISOString() });
      } catch (err) {
        refused.push(m.target);
        lastError = err;
      }
    }
    if (refused.length) {
      // The reload snaps the card back to its old day, which on its own is
      // indistinguishable from the drop never registering.
      toast.fail(`Could not move ${platformList(refused)}`, lastError);
    } else {
      // Posted, failed and in-flight platforms stay, and the card may stay with them.
      const stayed = group.targets.filter((t) => !moves.some((m) => m.target.id === t.id));
      if (stayed.length) {
        toast.info(`Moved ${platformList(moves.map((m) => m.target))}. ${platformList(stayed)} stayed put: only scheduled posts can move.`);
      }
    }
    void load();
  };

  /** Phone: retry a failed platform from its card, the same call the details sheet makes. */
  const retryTarget = async (t: PostTargetInfo) => {
    setRetrying(t.id);
    try {
      await api.post(`/posts/targets/${t.id}/retry`, {});
      toast.success(`${PLATFORM_LABELS[t.platform]} is queued again. It goes out in a minute.`);
    } catch (err) {
      toast.fail(`Could not retry ${PLATFORM_LABELS[t.platform]}`, err);
    } finally {
      setRetrying(null);
      void load();
    }
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
      ? { outline: "1.5px dashed rgba(250,97,75,.7)", outlineOffset: -2, borderRadius: 12 }
      : undefined;

  /*
   * Drive auto-post wins over a plain trial reel: the trial look, in violet.
   * Drive is a whole post. The trial look needs every platform to be a trial,
   * so a reel that is a trial only on Instagram does not dress its TikTok as
   * one; the Instagram tile carries the teal ring instead.
   */
  const kindCls = (g: PostGroup) =>
    g.targets.some((t) => t.drive) ? " trial drive" : g.targets.every((t) => t.trial) ? " trial" : "";
  const kindTag = (g: PostGroup) => {
    const drive = g.targets.some((t) => t.drive);
    return drive || g.targets.some((t) => t.trial) ? <span className="trialtag">{drive ? "Drive" : "Trial reel"}</span> : null;
  };
  const carouselMark = (g: PostGroup) =>
    g.lead.assetKind === "carousel" && (
      <span className="qcarousel" title="A carousel of images">
        ▤ {g.lead.slideCount || ""}
      </span>
    );

  /** Plain words for the hover, since the dot, the tiles and the padlock are shapes. One line per platform. */
  const evTitle = (g: PostGroup): string => {
    const t = g.lead;
    const kind = g.targets.some((x) => x.drive)
      ? "Drive auto-post - "
      : g.targets.every((x) => x.trial)
        ? "Instagram trial reel - "
        : t.assetKind === "carousel"
          ? `carousel of ${t.slideCount || "several"} - `
          : "";
    const lines = g.targets.map(
      (x) =>
        `${platformName(x)}: ${POST_STATUS[x.status].label.toLowerCase()}, ${targetTime(x, t)}` +
        (x.trial ? ", trial reel" : "") +
        (x.status === "failed" ? `, ${x.error ?? "unknown error"}` : ""),
    );
    const how = groupMovable(g) ? "Click for details, drag to move" : "Click for details. Nothing here can be moved.";
    return [`${kind}${t.assetName}`, ...lines, ...(isHeld(g) ? ["Held: uploads paused"] : []), how].join("\n");
  };

  const renderEvent = (g: PostGroup) => {
    const thumb = fileUrl(g.lead.thumbUrl);
    const status = groupStatus(g);
    const movable = groupMovable(g);
    const others = otherTimes(g);
    return (
      <div
        className={`ev st-${status}${isHeld(g) ? " held" : ""}${kindCls(g)}`}
        key={g.postId}
        title={evTitle(g)}
        draggable={movable}
        onDragStart={(e) => e.dataTransfer.setData("text/post", g.postId)}
        onClick={() => openCard(g)}
        style={{ cursor: movable ? "grab" : "pointer" }}
      >
        <div className="t1">
          <StatusDot status={status} />
          <span className="evwhen">{`${fmtTime(g.lead.scheduledAt!)} · ${POST_STATUS[status].label}`}</span>
          <StatusIcon status={status} />
        </div>
        <PlatformIcons group={g} />
        {others.length > 0 && <div className="evtimes">{others.join(" · ")}</div>}
        {isHeld(g) && heldBadge}
        {kindTag(g)}
        <div className="t2">
          {carouselMark(g)}
          {g.lead.assetName}
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
      target={detail.focus}
      siblings={detail.group.targets}
      // Only the loaded range: its days are complete, while a sibling past
      // its edge arrives without the rest of its day.
      knownTargets={targets.filter((t) => {
        const at = t.scheduledAt ? new Date(t.scheduledAt).getTime() : NaN;
        return at >= rangeStart.getTime() && at <= rangeEnd.getTime();
      })}
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
    // Phone calendar (mobile pass): one segmented control with Today and a
    // small pause pill, a week strip whose dots carry each post's status (it
    // swipes to the next week), one card per post with its platforms, other
    // times spelled out and a red strip with Retry right there when a
    // platform failed, "Add a post on <day>" at the end of the list, and a
    // colour key. Long-press a card to move it or open it.
    const strip = DOW.map((_, i) => {
      const d = mondayOf(anchor);
      d.setDate(d.getDate() + i);
      return d;
    });
    const dayGroups = (day: Date) => {
      const from = startOfDay(day);
      const to = new Date(from);
      to.setHours(23, 59, 59, 999);
      return groupByPost(targets, { from, to });
    };
    const dotTone = (g: PostGroup) => {
      if (g.targets.some((t) => t.status === "failed")) return "bad";
      if (g.targets.some((t) => t.drive)) return "drive";
      if (g.targets.every((t) => t.trial)) return "trial";
      const s = groupStatus(g);
      return s === "posted" ? "ok" : s === "scheduled" ? "info" : "";
    };
    const dayEvents = dayGroups(anchor);
    const todayStart = startOfDay(new Date());
    const isPast = (d: Date) => startOfDay(d) < todayStart;
    const weekday = anchor.toLocaleDateString("en-US", { weekday: "long" });
    const dayButton = (day: Date, key: string | number, label?: string) => {
      const gs = dayGroups(day);
      const on = day.toDateString() === anchor.toDateString();
      const hol = view === "month" ? holidayFor(day) : null;
      return (
        <button
          type="button"
          key={key}
          className={`mcal-day${on ? " on" : ""}${day.toDateString() === today ? " today" : ""}${isPast(day) && !on ? " past" : ""}${hol ? " hol" : ""}${moving ? " target" : ""}`}
          aria-pressed={on}
          aria-label={`${day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}, ${gs.length} ${gs.length === 1 ? "post" : "posts"}${hol ? `, ${hol.name}` : ""}`}
          onClick={() => {
            if (moving) {
              const g = moving;
              setMoving(null);
              void moveGroup(g, day);
              return;
            }
            setAnchor(startOfDay(day));
          }}
        >
          {label && <small>{label}</small>}
          <b>{day.getDate()}</b>
          {hol && <em className="mcal-star" aria-hidden="true">★</em>}
          <span className="mcal-dots" aria-hidden="true">
            {gs.slice(0, 3).map((g) => (
              <i key={g.postId} className={dotTone(g)} />
            ))}
          </span>
        </button>
      );
    };
    const rangeGroups = groups;
    const failedInRange = rangeGroups.filter((g) => g.targets.some((t) => t.status === "failed"));
    const firstFailedDay = failedInRange[0] ? new Date(failedInRange[0].lead.scheduledAt!) : null;
    const monthHolidays = view === "month" ? monthCells.filter((d): d is Date => !!d && !!holidayFor(d)) : [];
    const onSwipe = (dx: number) => {
      if (Math.abs(dx) < 60) return;
      step(dx < 0 ? 1 : -1);
    };
    const card = (g: PostGroup) => {
      const status = groupStatus(g);
      const failed = g.targets.find((t) => t.status === "failed");
      const reconnect = g.targets.some((t) => t.status === "failed" && /token|auth|expired|reconnect|permission|signed out/i.test(t.error ?? ""));
      const lead = g.lead;
      const leadTime = lead.scheduledAt ? new Date(lead.scheduledAt).getTime() : 0;
      const others = g.targets.filter((t) => t.scheduledAt && new Date(t.scheduledAt).getTime() !== leadTime);
      const drive = g.targets.some((t) => t.drive);
      const trial = g.targets.every((t) => t.trial);
      const carousel = lead.assetKind === "carousel";
      const thumb = fileUrl(lead.thumbUrl);
      const handles = [...new Set(g.targets.map((t) => t.accountHandle).filter(Boolean))] as string[];
      const sameAll = others.length === 0;
      const tone = failed ? " failed" : isHeld(g) ? " held" : drive ? " drive" : trial ? " trial" : "";
      return (
        <SwipeRow
          key={g.postId}
          className={`mb-post${tone}`}
          onLong={() => {
            suppressClick.current = true;
            setMenuFor(g);
          }}
          testId={`calendar.card.${g.postId}`}
        >
          <div
            className="mb-postin"
            role="button"
            tabIndex={0}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              openCard(g);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openCard(g);
              }
            }}
          >
            <span className={`mb-thumb${carousel ? " stack" : ""}`}>
              {thumb && <img src={thumb} alt="" />}
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href={carousel ? "#i-layers" : "#i-play"} />
              </svg>
              {carousel && lead.slideCount > 0 && <span className="mb-dur">{lead.slideCount}</span>}
            </span>
            <span className="mb-pb">
              <span className="mb-pt">
                <b>{lead.assetName}</b>
                <span className="mb-when">{lead.scheduledAt ? fmtTime(lead.scheduledAt).replace(/\s?[AP]M$/i, "") : ""}</span>
              </span>
              <span className="mb-pfs">
                {g.targets.map((t) => (
                  <span
                    key={t.id}
                    className={`mb-pfm ${t.status}${t.trial ? " trial" : ""}`}
                    role="img"
                    aria-label={`${platformName(t)}: ${POST_STATUS[t.status].label}, ${targetTime(t, lead)}`}
                  >
                    <Pf p={PF_ID[t.platform]} size="sm" />
                  </span>
                ))}
                {drive && (
                  <span className="mb-pill drive nodot">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-drive" />
                    </svg>
                    Drive
                  </span>
                )}
                {!drive && g.targets.some((t) => t.trial) && <span className="mb-pill trial nodot">Trial reel</span>}
                {carousel && <span className="mb-pill nodot">Carousel{lead.slideCount ? `, ${lead.slideCount} slides` : ""}</span>}
                {isHeld(g) && <span className="mb-pill paused nodot">Paused</span>}
                {others.length > 0 && !failed && (
                  <span className="mb-times inline">
                    {others.map((t) => `${PLATFORM_LABELS[t.platform]} at ${fmtTime(t.scheduledAt!)}`).join(", ")}
                  </span>
                )}
              </span>
              {failed ? (
                <span className="mb-fail">
                  <span className="mb-failtxt">
                    {PLATFORM_LABELS[failed.platform]}: {failed.error ?? "did not post"}
                  </span>
                  {reconnect ? (
                    <button
                      type="button"
                      className="mb-btn sm mb-retry"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate("settings", "accounts");
                      }}
                    >
                      Reconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mb-btn sm mb-retry"
                      disabled={retrying === failed.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void retryTarget(failed);
                      }}
                    >
                      {retrying === failed.id ? "Retrying" : "Retry"}
                    </button>
                  )}
                </span>
              ) : (
                <span className="mb-times">
                  {drive && handles.length
                    ? handles.map((h) => `@${h.replace(/^@/, "")}`).join(" and ")
                    : sameAll && g.targets.length > 1
                      ? `${g.targets.length === 2 ? "Both" : g.targets.length === 3 ? "All three" : `All ${g.targets.length}`} at ${fmtTime(lead.scheduledAt!)}. ${POST_STATUS[status].label}${groupMovable(g) ? ", can move." : "."}`
                      : others.length
                        ? ""
                        : `${POST_STATUS[status].label}${groupMovable(g) ? ", can move." : "."}`}
                </span>
              )}
            </span>
          </div>
        </SwipeRow>
      );
    };
    return (
      <section className="screen active mcal mb-page" data-screen="calendar" data-state={state}>
        <div className="mb-head">
          <div>
            <div className="mb-eyebrow">Calendar</div>
            <h1 className="mb-h1">{view === "day" ? anchor.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : MONTHS[anchor.getMonth()]}</h1>
          </div>
          <div className="mb-hnav">
            <button type="button" className="mb-ib" aria-label={`Previous ${view}`} onClick={() => step(-1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-chev-l" />
              </svg>
            </button>
            <button type="button" className="mb-ib" aria-label={`Next ${view}`} onClick={() => step(1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-chev-r" />
              </svg>
            </button>
          </div>
        </div>
        <div className="mb-calctl">
          <div className="mcal-views" role="tablist" aria-label="Calendar view">
            {(["day", "week", "month"] as CalView[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="mb-chip out" onClick={() => setAnchor(startOfDay(new Date()))}>
            Today
          </button>
          {selectedClient && (
            <button
              type="button"
              className={`mb-upl${paused ? " paused" : ""}`}
              aria-pressed={paused}
              aria-label={paused ? `Uploads paused for ${selectedClient.name}. Tap to continue` : `Uploads on for ${selectedClient.name}. Tap to pause`}
              disabled={pauseBusy}
              onClick={() => (paused ? void togglePause() : setAskPause(true))}
              data-testid="calendar.pause"
            >
              <i aria-hidden="true" />
              {paused ? "Paused" : "On"}
            </button>
          )}
        </div>

        {pauseBanner}
        {moving && (
          <div className="mb-banner info" role="status">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-cal" />
            </svg>
            <span className="mb-bt">
              <b>Moving {moving.lead.assetName}.</b> Tap a day. Only scheduled platforms move, each keeps its own time.
            </span>
            <button type="button" className="mb-btn sm" onClick={() => setMoving(null)}>
              Cancel
            </button>
          </div>
        )}
        {state === "empty" && (
          <div className="mb-empty">
            <span className="mb-ei">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-users" />
              </svg>
            </span>
            <h3>Pick a brand to see its calendar</h3>
            <p>Each brand has its own calendar of posts.</p>
            <button type="button" className="mb-btn pri" onClick={() => document.querySelector<HTMLButtonElement>('[data-testid="mobile.brand-switcher"]')?.click()}>
              Pick a brand
            </button>
          </div>
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

        {state === "ready" && (
          <>
            {view === "week" && (
              <>
                <div
                  className="mcal-strip"
                  onPointerDown={(e) => (swipeX.current = e.clientX)}
                  onPointerUp={(e) => {
                    if (swipeX.current != null) onSwipe(e.clientX - swipeX.current);
                    swipeX.current = null;
                  }}
                  style={{ touchAction: "pan-y" }}
                >
                  {strip.map((d, i) => dayButton(d, i, DOW[i]![0]))}
                </div>
                <div className="mb-weekline">
                  <span>Week of {MONTHS[strip[0]!.getMonth()]!.slice(0, 3)} {strip[0]!.getDate()}</span>
                  <span>
                    {rangeGroups.length} {rangeGroups.length === 1 ? "post" : "posts"}
                    {failedInRange.length ? `, ${failedInRange.length} failed` : ""}
                  </span>
                </div>
              </>
            )}
            {view === "month" && (
              <>
                <div
                  className="mcal-month"
                  onPointerDown={(e) => (swipeX.current = e.clientX)}
                  onPointerUp={(e) => {
                    if (swipeX.current != null) onSwipe(e.clientX - swipeX.current);
                    swipeX.current = null;
                  }}
                  style={{ touchAction: "pan-y" }}
                >
                  {DOW.map((d) => (
                    <span key={d} className="mcal-dow">
                      {d[0]}
                    </span>
                  ))}
                  {monthCells.map((d, i) => (d ? dayButton(d, i) : <span key={`b${i}`} />))}
                </div>
                <div className="mb-weekline">
                  <span>
                    {rangeGroups.length} {rangeGroups.length === 1 ? "post" : "posts"} in {MONTHS[anchor.getMonth()]}
                  </span>
                  {firstFailedDay && (
                    <button type="button" className="mb-linkbtn bad" onClick={() => setAnchor(startOfDay(firstFailedDay))}>
                      {failedInRange.length} failed, {firstFailedDay.toLocaleDateString("en-US", { weekday: "short" })} {firstFailedDay.getDate()}
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <use href="#i-chev-r" />
                      </svg>
                    </button>
                  )}
                </div>
                {monthHolidays.length > 0 && (
                  <div className="mb-chips">
                    {monthHolidays.map((d) => (
                      <button key={d.toDateString()} type="button" className="mb-chip mb-holchip" onClick={() => setAnchor(startOfDay(d))}>
                        ★ {holidayFor(d)!.name} <small>{d.getDate()}</small>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <div className="mb-dayhead">
              <h2 className="mb-h2">
                {view === "day" ? weekday : `${weekday} ${anchor.getDate()}`}
              </h2>
              <span className="mb-lab">
                {dayEvents.length} {dayEvents.length === 1 ? "post" : "posts"}
              </span>
            </div>
            {holidayRow(anchor)}
            {dayEvents.length === 0 && (
              <div className="mb-empty mb-dayempty">
                <span className="mb-ei">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-cal" />
                  </svg>
                </span>
                <h3>Nothing on {weekday} yet</h3>
                <p>{isPast(anchor) ? "Nothing went out this day." : "Upload a video for this day, or plan one from a draft."}</p>
                {!isPast(anchor) && (
                  <div className="mb-btnrow">
                    <button type="button" className="mb-btn pri" onClick={onNewPost}>
                      Upload
                    </button>
                    <button type="button" className="mb-btn ghost" onClick={() => navigate("fanout")}>
                      Plan a post
                    </button>
                  </div>
                )}
              </div>
            )}
            {dayEvents.map(card)}
            {dayEvents.length > 0 && !isPast(anchor) && (
              <button type="button" className="mb-addrow" onClick={onNewPost} data-testid="calendar.new-post">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-plus" />
                </svg>
                Add a post on {weekday}
              </button>
            )}
            <div className="mb-key" aria-label="Colour key">
              <span style={{ ["--c" as string]: "var(--c-ok)" }}>
                <i />
                Posted
              </span>
              <span style={{ ["--c" as string]: "var(--c-info)" }}>
                <i />
                Scheduled
              </span>
              <span style={{ ["--c" as string]: "var(--c-bad)" }}>
                <i />
                Failed
              </span>
              <span style={{ ["--c" as string]: "var(--c-drive)" }}>
                <i />
                Drive
              </span>
              <span style={{ ["--c" as string]: "var(--c-trial)" }}>
                <i />
                Trial
              </span>
              <span style={{ ["--c" as string]: "var(--c-paused)" }}>
                <i />
                Paused
              </span>
              {view === "month" && (
                <>
                  <span style={{ ["--c" as string]: "var(--c-warn)" }}>
                    <i />
                    Publishing
                  </span>
                  <span style={{ ["--c" as string]: "var(--mb-muted)" }}>
                    <i />
                    Sent to client
                  </span>
                  <span className="mb-keystar">★ Holiday</span>
                </>
              )}
            </div>
          </>
        )}

        {menuFor && (
          <>
            <div className="mb-scrim" onClick={() => setMenuFor(null)} aria-hidden="true" />
            <div className="mb-sheet" role="dialog" aria-modal="true" aria-label={menuFor.lead.assetName}>
              <div className="mb-grab" aria-hidden="true" />
              <div className="mb-sh">
                <div className="mb-ttl">
                  <h2>{menuFor.lead.assetName}</h2>
                  <small>{menuFor.lead.scheduledAt ? new Date(menuFor.lead.scheduledAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</small>
                </div>
                <button type="button" className="mb-ib" aria-label="Close" onClick={() => setMenuFor(null)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-x" />
                  </svg>
                </button>
              </div>
              <div className="mb-shb">
                <button
                  type="button"
                  className="mb-lrow"
                  disabled={!groupMovable(menuFor)}
                  onClick={() => {
                    const g = menuFor;
                    setMenuFor(null);
                    if (view === "day") setView("week");
                    setMoving(g);
                  }}
                >
                  <span className="mb-lic n">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-calplus" />
                    </svg>
                  </span>
                  <span className="mb-lt">
                    <b>Move to another day</b>
                    <small>{groupMovable(menuFor) ? "Then tap a day. Each platform keeps its own time." : "Nothing here can move: it already went out."}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="mb-lrow"
                  onClick={() => {
                    const g = menuFor;
                    setMenuFor(null);
                    openCard(g);
                  }}
                >
                  <span className="mb-lic n">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-pencil" />
                    </svg>
                  </span>
                  <span className="mb-lt">
                    <b>Details, times and caption</b>
                    <small>Change a platform's time, the caption or the cover, or remove it</small>
                  </span>
                </button>
              </div>
            </div>
          </>
        )}
        {askPause && selectedClient && (
          <ConfirmSheet
            title={`Pause uploads for ${selectedClient.name}?`}
            body="Scheduled posts are held, not deleted. Continue moves them forward so the first lands on the day you resume."
            confirm="Pause uploads"
            onConfirm={() => {
              setAskPause(false);
              void togglePause();
            }}
            onClose={() => setAskPause(false)}
          />
        )}
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
          {pauseToggle}
          <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--txt-2)" }}>
            {rangeLabel}
          </div>
        </div>

        {pauseBanner}

        {/* Always on, in every view: the key to the dots and the padlocks. */}
        <div className="callegend">
          {(Object.keys(POST_STATUS) as PostStatus[]).map((s) => (
            <span className="litem" key={s}>
              <StatusDot status={s} decorative />
              <StatusIcon status={s} />
              {POST_STATUS[s].label}<span className="lhint">, {POST_STATUS[s].hint}</span>
            </span>
          ))}
          <span className="litem held">
            <StatusDot status="scheduled" decorative />
            <StatusIcon status="scheduled" />
            Paused<span className="lhint">, held until uploads continue</span>
          </span>
          <span className="litem">
            <span className="pfmark st-posted" aria-hidden="true">
              <Pf p="ig" size="sm" />
            </span>
            Platform tiles<span className="lhint">, a check once that platform posted, red if it failed</span>
          </span>
          <span className="litem">
            <span className="trialswatch" aria-hidden="true" />
            Trial reel<span className="lhint">, Instagram trial reels, shown to non-followers first</span>
          </span>
          <span className="litem drive">
            <span className="trialswatch" aria-hidden="true" />
            Drive auto-post<span className="lhint">, trial reels from the brand's Drive folder (Workflows), changeable until they go out</span>
          </span>
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
                      .map((g) => {
                        const movable = groupMovable(g);
                        const status = groupStatus(g);
                        return (
                          <div
                            className={`mev st-${status}${isHeld(g) ? " held" : ""}${kindCls(g)}`}
                            key={g.postId}
                            title={evTitle(g)}
                            draggable={movable}
                            style={{ cursor: movable ? "grab" : "pointer" }}
                            onDragStart={(e) => e.dataTransfer.setData("text/post", g.postId)}
                            onClick={() => openCard(g)}
                          >
                            <StatusDot status={status} />
                            <PlatformIcons group={g} />
                            <span className="evwhen">{fmtTime(g.lead.scheduledAt!)}</span>
                            <StatusIcon status={status} />
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
          One card per post, with a tile for each platform it goes to: a check once that platform
          has posted, red if it failed. Click a card to see and change each platform's own time,
          or drag it to move all its scheduled platforms to another day. Anything already posted
          or going out now is locked. Holidays appear as reminders across all views.
        </div>
      </div>

      {detailModal}
    </section>
  );
}
