import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  DEFAULT_TEXT_STYLE,
  addCut,
  adjustTailCut,
  edlFromDoc,
  locate,
  outputDuration,
  splitAt,
  toOutputTime,
} from "@toreroflow/core";
import { fileUrl } from "../lib/api";
import { useEditor, type EditAssetInfo, type Selection } from "./StudioEditor";
import "./Timeline.css";

import PanelArea from "./panels";
import {
  ASSET_DRAG_MIME as DRAG_MIME,
  ClipsDrawer,
  AudioDrawer,
  GraphicsDrawer,
} from "./panels/Drawers";

type DrawerKind = "clips" | "audio" | "graphics";

/** Left gutter so the playhead bubble at 0:00 is not clipped. */
const PAD = 16;
const MIN_PPS = 2;
const MAX_PPS = 500;
const MIN_DUR = 0.2;

type Lane = "texts" | "broll" | "graphics" | "audio";

interface ChipDrag {
  lane: Lane;
  id: string;
  mode: "move" | "l" | "r";
  startX: number;
  dx: number;
  moved: boolean;
}

function newId(): string {
  return crypto.randomUUID();
}

/** m:ss.t for the playhead bubble, e.g. "0:06.9". */
function fmtT(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** m:ss for ruler labels. */
function fmtLabel(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One item nudged or resized; at stays >= 0, dur stays >= MIN_DUR. */
function adjust<T extends { id: string; at: number; dur: number }>(
  list: T[],
  id: string,
  mode: "move" | "l" | "r",
  dSec: number,
): T[] {
  return list.map((it) => {
    if (it.id !== id) return it;
    if (mode === "move") return { ...it, at: Math.max(0, it.at + dSec) };
    if (mode === "r") return { ...it, dur: Math.max(MIN_DUR, it.dur + dSec) };
    const at = Math.min(it.at + it.dur - MIN_DUR, Math.max(0, it.at + dSec));
    return { ...it, at, dur: it.dur + (it.at - at) };
  });
}

function readDrag(e: ReactDragEvent): { assetId: string; kind: string } | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    const v = JSON.parse(raw) as { assetId?: string; kind?: string };
    return v.assetId && v.kind ? { assetId: v.assetId, kind: v.kind } : null;
  } catch {
    return null;
  }
}

export default function Timeline() {
  const {
    doc,
    update,
    assets,
    outputTime,
    seek,
    playing,
    setPlaying,
    selection,
    setSelection,
    tool,
    setTool,
  } = useEditor();

  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [zoomPps, setZoomPps] = useState<number | null>(null);
  const [viewW, setViewW] = useState(0);
  const [chipDrag, setChipDrag] = useState<ChipDrag | null>(null);
  const [trim, setTrim] = useState<{ assetId: string; startX: number; dx: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);
  const anchor = useRef<{ t: number; screenX: number } | null>(null);

  const byId = useMemo(() => {
    const m: Record<string, EditAssetInfo> = {};
    for (const a of assets) m[a.id] = a;
    return m;
  }, [assets]);

  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    return d;
  }, [assets]);

  // The EDL only reads clips and cuts, so a text edit does not rebuild it.
  const edl = useMemo(
    () => edlFromDoc(doc, durations),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.clips, doc.cuts, durations],
  );
  const total = useMemo(() => outputDuration(edl), [edl]);
  const clampT = total > 0 ? Math.min(Math.max(0, outputTime), total) : 0;

  /* ---- scale ---- */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Ten ruler seconds keep an empty project from rendering a zero-width strip.
  const displayTotal = Math.max(total, 10);
  const fitPps =
    viewW > 0 ? Math.max(MIN_PPS, (viewW - PAD * 2 - 2) / displayTotal) : 40;
  const pps = zoomPps ?? fitPps;
  const contentW = Math.max(viewW, PAD * 2 + displayTotal * pps);
  const X = (t: number) => PAD + t * pps;

  const zoomBy = useCallback(
    (f: number) => {
      const scroller = scrollRef.current;
      anchor.current = { t: clampT, screenX: X(clampT) - (scroller?.scrollLeft ?? 0) };
      setZoomPps(Math.min(MAX_PPS, Math.max(MIN_PPS, pps * f)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clampT, pps],
  );

  // After a zoom the playhead keeps its on-screen position.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = Math.max(0, PAD + a.t * pps - a.screenX);
  }, [pps]);

  const fitToWindow = useCallback(() => {
    setZoomPps(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, []);

  /* ---- clip blocks, output order, contiguous ---- */

  const blocks = useMemo(() => {
    const out: Array<{
      assetId: string;
      start: number;
      vis: number;
      seams: number[];
      splits: number[];
    }> = [];
    let i = 0;
    let acc = 0;
    for (const { assetId } of doc.clips) {
      const segs: typeof edl = [];
      let vis = 0;
      while (i < edl.length && edl[i].assetId === assetId) {
        segs.push(edl[i]);
        vis += edl[i].srcOut - edl[i].srcIn;
        i++;
      }
      const seams: number[] = [];
      if (segs.length > 0) {
        if (segs[0].srcIn > 0.01) seams.push(0);
        let off = 0;
        for (let k = 0; k < segs.length - 1; k++) {
          off += segs[k].srcOut - segs[k].srcIn;
          seams.push(off);
        }
        const dur = durations[assetId] ?? 0;
        if (dur - segs[segs.length - 1].srcOut > 0.01) seams.push(vis);
      }
      const splits = (doc.splits[assetId] ?? [])
        .map((s) => toOutputTime(edl, assetId, s))
        .filter((t): t is number => t !== null)
        .map((t) => t - acc);
      out.push({ assetId, start: acc, vis, seams, splits });
      acc += vis;
    }
    return out;
  }, [doc.clips, doc.splits, edl, durations]);

  /* ---- seek and scrub ---- */

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = bodyRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return Math.min(Math.max(0, (clientX - r.left - PAD) / pps), Math.max(0, total));
    },
    [pps, total],
  );

  const onBodyDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".tl-chip,.tl-clip,button")) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests, automation) have no capturable id; the
      // scrub still works from the move events alone.
    }
    scrubbing.current = true;
    seek(timeAtClientX(e.clientX));
  };
  const onBodyMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current && e.buttons & 1) seek(timeAtClientX(e.clientX));
  };
  const onBodyUp = () => {
    scrubbing.current = false;
  };

  /* ---- chip drag: move, resize either edge, click selects ---- */

  const onChipDown = (e: ReactPointerEvent<HTMLDivElement>, lane: Lane, id: string) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const mode: ChipDrag["mode"] =
      e.clientX < r.left + 8 ? "l" : e.clientX > r.right - 8 ? "r" : "move";
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers have no capturable id; the drag still works.
    }
    setChipDrag({ lane, id, mode, startX: e.clientX, dx: 0, moved: false });
  };

  const onChipMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!chipDrag || !(e.buttons & 1)) return;
    const dx = e.clientX - chipDrag.startX;
    setChipDrag({ ...chipDrag, dx, moved: chipDrag.moved || Math.abs(dx) > 3 });
  };

  const selectionFor = (lane: Lane, id: string): Selection => {
    if (lane === "texts") return { kind: "text", id };
    if (lane === "broll") return { kind: "broll", id };
    if (lane === "graphics") return { kind: "graphic", id };
    return { kind: "audio", id };
  };

  const onChipUp = (lane: Lane, id: string) => {
    if (!chipDrag) return;
    if (!chipDrag.moved) {
      setSelection(selectionFor(lane, id));
    } else {
      const dSec = chipDrag.dx / pps;
      if (dSec !== 0) {
        update((d) => {
          if (lane === "texts") return { ...d, texts: adjust(d.texts, id, chipDrag.mode, dSec) };
          if (lane === "broll") return { ...d, broll: adjust(d.broll, id, chipDrag.mode, dSec) };
          if (lane === "graphics")
            return { ...d, graphics: adjust(d.graphics, id, chipDrag.mode, dSec) };
          return { ...d, audio: adjust(d.audio, id, chipDrag.mode, dSec) };
        });
      }
    }
    setChipDrag(null);
  };

  /* ---- row packing: overlapping chips stack instead of covering each other ---- */

  const ROW_H = 28;
  /** First-fit rows by start time; a chip takes the first row whose last
   *  occupant has ended. Two texts at the same moment land on two rows. */
  const packRows = (
    items: Array<{ id: string; at: number; dur: number }>,
  ): Record<string, number> => {
    const rowEnds: number[] = [];
    const out: Record<string, number> = {};
    for (const it of [...items].sort((a, b) => a.at - b.at)) {
      let r = rowEnds.findIndex((end) => it.at >= end - 0.001);
      if (r === -1) {
        r = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[r] = it.at + it.dur;
      out[it.id] = r;
    }
    return out;
  };
  const textRows = useMemo(() => packRows(doc.texts), [doc.texts]);
  const brollRows = useMemo(
    () => packRows([...doc.broll, ...doc.graphics]),
    [doc.broll, doc.graphics],
  );
  const audioRows = useMemo(() => packRows(doc.audio), [doc.audio]);
  const laneHeight = (rows: Record<string, number>, min: number): number =>
    Math.max(min, 8 + (Math.max(-1, ...Object.values(rows)) + 1) * ROW_H);
  const rowTop = (rows: Record<string, number>, id: string) => ({
    top: 4 + (rows[id] ?? 0) * ROW_H,
  });

  const chipStyle = (lane: Lane, it: { id: string; at: number; dur: number }): CSSProperties => {
    let width = Math.max(12, it.dur * pps);
    let tx = 0;
    if (chipDrag && chipDrag.lane === lane && chipDrag.id === it.id && chipDrag.moved) {
      if (chipDrag.mode === "move") tx = chipDrag.dx;
      else if (chipDrag.mode === "r") width = Math.max(12, width + chipDrag.dx);
      else {
        tx = Math.min(chipDrag.dx, width - 12);
        width = Math.max(12, width - chipDrag.dx);
      }
    }
    return {
      left: X(it.at),
      width,
      transform: tx !== 0 ? `translateX(${tx}px)` : undefined,
    };
  };

  const chipSelected = (lane: Lane, id: string) =>
    selection !== null && "id" in selection && selection.id === id &&
    selection.kind === (lane === "texts" ? "text" : lane === "graphics" ? "graphic" : lane);

  /* ---- trim: the coral right edge moves both ways ----
     Left adds to the tail cut; right gives the hidden tail back. The rightward
     cap is however much a tail cut is currently hiding, so a never-trimmed
     clip's handle simply does not move right: there is nothing to restore. */

  /** Seconds hidden by this asset's end-touching cut, 0 when there is none. */
  const tailHidden = (assetId: string): number => {
    const duration = durations[assetId];
    if (!(duration > 0)) return 0;
    const tail = (doc.cuts[assetId] ?? []).find((c) => c.end >= duration - 0.001);
    return tail ? tail.end - tail.start : 0;
  };

  /**
   * How far LEFT the trim handle may go, in seconds: to the last interior cut
   * and no further. Crossing one would merge it into the tail cut, and the
   * merged cut has no memory of which part was deleted words; a later
   * rightward drag would bring those words back. Stopping the handle at the
   * boundary keeps every deletion a deletion. The small gap keeps
   * normalizeCuts from fusing the two cuts when the handle is dropped
   * exactly at the limit.
   */
  const trimLeftRoom = (assetId: string, vis: number): number => {
    const duration = durations[assetId];
    if (!(duration > 0)) return Math.max(0, vis - MIN_DUR);
    const cuts = doc.cuts[assetId] ?? [];
    const tail = cuts.find((c) => c.end >= duration - 0.001);
    const interiorEnds = cuts
      .filter((c) => c !== tail)
      .map((c) => c.end)
      .filter((e) => e < duration - 0.001);
    if (!interiorEnds.length) return Math.max(0, vis - MIN_DUR);
    const tailStart = tail ? tail.start : duration;
    const run = tailStart - Math.max(...interiorEnds) - 0.05;
    return Math.max(0, Math.min(vis - MIN_DUR, run));
  };

  const onTrimDown = (e: ReactPointerEvent<HTMLDivElement>, assetId: string) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers have no capturable id; the drag still works.
    }
    setTrim({ assetId, startX: e.clientX, dx: 0 });
  };
  const onTrimMove = (e: ReactPointerEvent<HTMLDivElement>, vis: number) => {
    if (!trim || !(e.buttons & 1)) return;
    const dx = Math.min(
      tailHidden(trim.assetId) * pps,
      Math.max(-trimLeftRoom(trim.assetId, vis) * pps, e.clientX - trim.startX),
    );
    setTrim({ ...trim, dx });
  };
  const onTrimUp = (vis: number) => {
    if (!trim) return;
    const dSec = trim.dx / pps;
    const assetId = trim.assetId;
    setTrim(null);
    if (Math.abs(dSec) < 0.01) return;
    const duration = durations[assetId];
    if (!(duration > 0)) return;
    if (dSec > 0) {
      // Restoring N visible seconds slides the tail cut's start right by
      // exactly N source seconds: the hidden tail is one contiguous range,
      // so no EDL walk is needed on this side.
      update((d) => adjustTailCut(d, assetId, dSec, duration));
      return;
    }
    // Source time of the new visible end, walked over this asset's segments.
    let remain = Math.max(MIN_DUR, vis + dSec);
    let srcEnd = duration;
    for (const seg of edl) {
      if (seg.assetId !== assetId) continue;
      const len = seg.srcOut - seg.srcIn;
      if (remain <= len) {
        srcEnd = seg.srcIn + remain;
        break;
      }
      remain -= len;
    }
    update((d) => addCut(d, assetId, { start: srcEnd, end: duration }, duration));
  };

  /* ---- track buttons ---- */

  const addText = () => {
    const id = newId();
    const at = Math.max(0, Math.min(clampT, Math.max(0, total - MIN_DUR)));
    update((d) => ({
      ...d,
      texts: [
        ...d.texts,
        {
          id,
          at,
          dur: 2.5,
          content: "New Text",
          x: 0,
          y: 0,
          style: JSON.parse(JSON.stringify(DEFAULT_TEXT_STYLE)) as typeof DEFAULT_TEXT_STYLE,
          animIn: "none" as const,
          animOut: "none" as const,
        },
      ],
    }));
    setSelection({ kind: "text", id });
  };

  /* ---- drops from the drawers ---- */

  const allowDrop = (e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) e.preventDefault();
  };

  const onBrollDrop = (e: ReactDragEvent) => {
    const data = readDrag(e);
    if (!data) return;
    e.preventDefault();
    const at = timeAtClientX(e.clientX);
    const id = newId();
    if (data.kind === "graphic") {
      update((d) => ({
        ...d,
        graphics: [
          ...d.graphics,
          { id, assetId: data.assetId, at, dur: 2.5, x: 0, y: 0, scale: 0.45, rotate: 0, opacity: 100 },
        ],
      }));
      setSelection({ kind: "graphic", id });
    } else if (data.kind === "clip") {
      const dur = Math.max(0.5, byId[data.assetId]?.durationSec ?? 2.5);
      update((d) => ({
        ...d,
        broll: [
          ...d.broll,
          {
            id,
            assetId: data.assetId,
            at,
            dur,
            x: 0,
            y: 0,
            scale: 0.45,
            shape: "full" as const,
            volume: 100,
            fadeIn: 0,
            fadeOut: 0,
          },
        ],
      }));
      setSelection({ kind: "broll", id });
    }
  };

  const onAudioDrop = (e: ReactDragEvent) => {
    const data = readDrag(e);
    if (!data || data.kind !== "audio") return;
    e.preventDefault();
    const at = timeAtClientX(e.clientX);
    const dur = Math.max(0.5, byId[data.assetId]?.durationSec ?? 5);
    const id = newId();
    update((d) => ({
      ...d,
      audio: [...d.audio, { id, assetId: data.assetId, at, dur, volume: 100, kind: "music" as const }],
    }));
    setSelection({ kind: "audio", id });
  };

  /* ---- selection strip actions ---- */

  const selectedClipId = selection?.kind === "clip" ? selection.assetId : null;

  const excerpt = useMemo(() => {
    if (!selectedClipId) return "";
    const words = byId[selectedClipId]?.words ?? [];
    let s = "";
    for (const w of words) {
      if (s.length >= 200) break;
      s += (s ? " " : "") + w.word;
    }
    return s;
  }, [selectedClipId, byId]);

  const doSplit = () => {
    if (!selectedClipId || total <= 0) return;
    const loc = locate(edl, Math.min(clampT, total - 0.001));
    if (!loc || loc.assetId !== selectedClipId) return;
    update((d) => splitAt(d, selectedClipId, loc.srcTime));
  };

  const moveToBroll = () => {
    if (!selectedClipId) return;
    const b = blocks.find((x) => x.assetId === selectedClipId);
    if (!b) return;
    const dur = b.vis > MIN_DUR ? b.vis : Math.max(MIN_DUR, byId[selectedClipId]?.durationSec ?? 2.5);
    const id = newId();
    update((d) => ({
      ...d,
      clips: d.clips.filter((c) => c.assetId !== selectedClipId),
      broll: [
        ...d.broll,
        {
          id,
          assetId: selectedClipId,
          at: b.start,
          dur,
          x: 0,
          y: 0,
          scale: 0.45,
          shape: "full" as const,
          volume: 100,
          fadeIn: 0,
          fadeOut: 0,
        },
      ],
    }));
    setSelection({ kind: "broll", id });
  };

  const moveToMain = (id: string) => {
    const item = doc.broll.find((b) => b.id === id);
    if (!item) return;
    update((d) => ({
      ...d,
      broll: d.broll.filter((b) => b.id !== id),
      clips: [...d.clips, { assetId: item.assetId }],
    }));
    setSelection({ kind: "clip", assetId: item.assetId });
  };

  const deleteClip = () => {
    if (!selectedClipId) return;
    update((d) => ({ ...d, clips: d.clips.filter((c) => c.assetId !== selectedClipId) }));
    setSelection(null);
  };

  /* ---- render ---- */

  const seconds: number[] = [];
  for (let s = 0; s <= Math.ceil(displayTotal); s++) seconds.push(s);

  const trackBtn = (
    label: string,
    kind: DrawerKind | "text",
    icon: ReactElement,
    onClick: () => void,
  ) => (
    <button
      key={label}
      className={`tl-track glass-sm${drawer === kind ? " on" : ""}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <>
      <div className="card glass tl">
        <div className="tl-tracks">
          {trackBtn(
            "Clips",
            "clips",
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 5v14M17 5v14M3 10h4M3 15h4M17 10h4M17 15h4" />
            </svg>,
            () => setDrawer(drawer === "clips" ? null : "clips"),
          )}
          {trackBtn(
            "Audio",
            "audio",
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 18V6l11-2v12" />
              <circle cx="6.5" cy="18" r="2.5" />
              <circle cx="17.5" cy="16" r="2.5" />
            </svg>,
            () => setDrawer(drawer === "audio" ? null : "audio"),
          )}
          {trackBtn(
            "Graphics",
            "graphics",
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="9" cy="10" r="2" />
              <path d="M3 17l5-4 4 3 4-4 5 5" />
            </svg>,
            () => setDrawer(drawer === "graphics" ? null : "graphics"),
          )}
          {trackBtn(
            "Text",
            "text",
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7V5h14v2M12 5v14M9 19h6" />
            </svg>,
            addText,
          )}
        </div>

        <ClipsDrawer
          open={drawer === "clips"}
          onClose={() => setDrawer(null)}
          onTab={setDrawer}
        />
        <AudioDrawer
          open={drawer === "audio"}
          onClose={() => setDrawer(null)}
          onTab={setDrawer}
        />
        <GraphicsDrawer
          open={drawer === "graphics"}
          onClose={() => setDrawer(null)}
          onTab={setDrawer}
        />

        <div className="tl-scroll" ref={scrollRef}>
          <div
            className="tl-body"
            ref={bodyRef}
            style={{ width: contentW, cursor: tool === "blade" ? "crosshair" : undefined }}
            onPointerDown={onBodyDown}
            onPointerMove={onBodyMove}
            onPointerUp={onBodyUp}
          >
            <div className="tl-ruler">
              {seconds.map((s) => (
                <span key={s}>
                  <i
                    className={`tl-tick${s % 5 === 0 ? " big" : ""}`}
                    style={{ left: X(s) }}
                  />
                  {s % 5 === 0 && (
                    <i className="tl-ticklab" style={{ left: X(s) }}>
                      {fmtLabel(s)}
                    </i>
                  )}
                </span>
              ))}
            </div>

            <div
              className="tl-lane tl-lane-text"
              style={{ height: laneHeight(textRows, 32) }}
            >
              <span className="tl-lanelab">
                <i style={{ background: "var(--v)" }} />Text
              </span>
              {doc.texts.map((t) => (
                <div
                  key={t.id}
                  className={`tl-chip tl-chip-text${chipSelected("texts", t.id) ? " on" : ""}`}
                  style={{ ...chipStyle("texts", t), ...rowTop(textRows, t.id) }}
                  onPointerDown={(e) => onChipDown(e, "texts", t.id)}
                  onPointerMove={onChipMove}
                  onPointerUp={() => onChipUp("texts", t.id)}
                >
                  <span className="tl-edge l" />
                  T: {t.content.trim().split(/\s+/).slice(0, 3).join(" ") || "New Text"}
                  <span className="tl-edge r" />
                </div>
              ))}
            </div>

            <div
              className="tl-lane tl-lane-broll"
              style={{ height: laneHeight(brollRows, 36) }}
              onDragOver={allowDrop}
              onDrop={onBrollDrop}
            >
              <span className="tl-lanelab">
                <i style={{ background: "#5AA9FF" }} />B-roll
              </span>
              {drawer === "graphics" &&
                doc.broll.length === 0 &&
                doc.graphics.length === 0 && (
                  <div className="tl-hint">Drop clips or graphics here for B-roll</div>
                )}
              {doc.broll.map((b) => (
                <div
                  key={b.id}
                  className={`tl-chip tl-chip-broll${chipSelected("broll", b.id) ? " on" : ""}`}
                  style={{ ...chipStyle("broll", b), ...rowTop(brollRows, b.id) }}
                  onPointerDown={(e) => onChipDown(e, "broll", b.id)}
                  onPointerMove={onChipMove}
                  onPointerUp={() => onChipUp("broll", b.id)}
                >
                  <span className="tl-edge l" />
                  {byId[b.assetId]?.originalName ?? "B-roll"}
                  {chipSelected("broll", b.id) && (
                    <button className="tl-chipbtn" onClick={() => moveToMain(b.id)}>
                      Move to main
                    </button>
                  )}
                  <span className="tl-edge r" />
                </div>
              ))}
              {doc.graphics.map((g) => (
                <div
                  key={g.id}
                  className={`tl-chip tl-chip-graphic${chipSelected("graphics", g.id) ? " on" : ""}`}
                  style={{ ...chipStyle("graphics", g), ...rowTop(brollRows, g.id) }}
                  onPointerDown={(e) => onChipDown(e, "graphics", g.id)}
                  onPointerMove={onChipMove}
                  onPointerUp={() => onChipUp("graphics", g.id)}
                >
                  <span className="tl-edge l" />
                  {byId[g.assetId]?.originalName ?? "Graphic"}
                  <span className="tl-edge r" />
                </div>
              ))}
            </div>

            <div className="tl-lane tl-lane-clips">
              {total <= 0 && (
                <div className="tl-hint">Add clips in step 1 to build the timeline</div>
              )}
              {blocks.map((b) => {
                const trimming = trim?.assetId === b.assetId ? trim.dx : 0;
                // A rightward drag previews as the block itself widening into
                // the footage it is about to get back.
                const width = Math.max(24, b.vis * pps + Math.max(0, trimming));
                return (
                  <div
                    key={b.assetId}
                    className={`tl-clip${selectedClipId === b.assetId ? " on" : ""}`}
                    style={{ left: X(b.start), width }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest(".tl-trim")) return;
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      if (tool !== "blade") {
                        setSelection({ kind: "clip", assetId: b.assetId });
                        return;
                      }
                      // Blade: the click point in visible seconds, walked to
                      // source time over this asset's own segments, exactly
                      // the way the trim commit does it.
                      const r = e.currentTarget.getBoundingClientRect();
                      let remain = Math.max(0.05, (e.clientX - r.left) / pps);
                      let src: number | null = null;
                      for (const seg of edl) {
                        if (seg.assetId !== b.assetId) continue;
                        const len = seg.srcOut - seg.srcIn;
                        if (remain <= len) {
                          src = seg.srcIn + remain;
                          break;
                        }
                        remain -= len;
                      }
                      if (src !== null) update((d) => splitAt(d, b.assetId, src));
                      setTool("select");
                    }}
                  >
                    <div className="tl-clipname">
                      {byId[b.assetId]?.originalName ?? "Clip"}
                    </div>
                    <div
                      className="tl-film"
                      style={{
                        backgroundImage: byId[b.assetId]?.stripUrl
                          ? `url(${fileUrl(byId[b.assetId]!.stripUrl)})`
                          : undefined,
                      }}
                    />
                    {b.seams.map((s, i) => (
                      <i key={`n${i}`} className="tl-notch" style={{ left: s * pps }} />
                    ))}
                    {b.splits.map((s, i) => (
                      <i key={`s${i}`} className="tl-splitline" style={{ left: s * pps }} />
                    ))}
                    <div className="tl-durbadge">{b.vis.toFixed(1)}s</div>
                    {trimming < 0 && (
                      <div className="tl-trimshade" style={{ width: -trimming }} />
                    )}
                    <div
                      className="tl-trim"
                      title={
                        tailHidden(b.assetId) > 0
                          ? "Drag left to shorten, right to bring trimmed footage back"
                          : "Drag left to shorten"
                      }
                      style={{
                        transform: trimming < 0 ? `translateX(${trimming}px)` : undefined,
                      }}
                      onPointerDown={(e) => onTrimDown(e, b.assetId)}
                      onPointerMove={(e) => onTrimMove(e, b.vis)}
                      onPointerUp={() => onTrimUp(b.vis)}
                    />
                  </div>
                );
              })}
            </div>

            <div
              className="tl-lane tl-lane-audio"
              style={{ height: laneHeight(audioRows, 36) }}
              onDragOver={allowDrop}
              onDrop={onAudioDrop}
            >
              <span className="tl-lanelab">
                <i style={{ background: "#4FE29A" }} />Audio
              </span>
              {drawer === "audio" && doc.audio.length === 0 && (
                <div className="tl-hint">Drop audio here</div>
              )}
              {doc.audio.map((a) => (
                <div
                  key={a.id}
                  className={`tl-chip tl-chip-audio${chipSelected("audio", a.id) ? " on" : ""}`}
                  style={{ ...chipStyle("audio", a), ...rowTop(audioRows, a.id) }}
                  onPointerDown={(e) => onChipDown(e, "audio", a.id)}
                  onPointerMove={onChipMove}
                  onPointerUp={() => onChipUp("audio", a.id)}
                >
                  <span className="tl-edge l" />
                  {byId[a.assetId]?.originalName ?? a.kind}
                  <span className="tl-edge r" />
                </div>
              ))}
            </div>

            <div
              className="tl-ph"
              style={{ transform: `translateX(${X(clampT)}px)` }}
            >
              <span className="tl-ph-bubble">{fmtT(clampT)}</span>
              <span className="tl-ph-line" />
              <span className="tl-ph-grab" />
            </div>
          </div>
        </div>

        {selectedClipId && (
          <div className="tl-selstrip glass-sm">
            <div className="tl-excerpt mini">
              {excerpt || "No transcript for this clip."}
            </div>
            <div className="tl-selbtns">
              <button className="cbtn" onClick={doSplit}>
                Split
              </button>
              <button className="btn ghost tl-smallbtn" onClick={moveToBroll}>
                Move to B-roll
              </button>
              <button className="dangerbtn" onClick={deleteClip}>
                Delete
              </button>
              <button
                className="iconbtn tl-smallicon"
                title="Deselect"
                onClick={() => setSelection(null)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="tl-transport">
          <button className="iconbtn" title="Back to start" onClick={() => seek(0)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5v14" />
              <path d="M19 5l-10 7 10 7V5z" />
            </svg>
          </button>
          <button className="iconbtn" title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            className="iconbtn tl-play"
            title={playing ? "Pause" : "Play"}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 5v14M15 5v14" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-play" />
              </svg>
            )}
          </button>
          <button className="iconbtn" title="Zoom in" onClick={() => zoomBy(1.4)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button className="iconbtn" title="Fit to window" onClick={fitToWindow}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
            </svg>
          </button>
        </div>
      </div>

      <PanelArea />
    </>
  );
}
