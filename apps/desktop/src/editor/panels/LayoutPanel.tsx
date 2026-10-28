import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DEFAULT_LAYOUT,
  clearShotAdjust,
  edlFromDoc,
  layoutAt,
  locate,
  outputSize,
  setClipLayout,
  setShotAdjust,
  toOutputTime,
  type ClipLayout,
  type LayoutKind,
  type Rect,
} from "@toreroflow/core";
import { fileUrl } from "../../lib/api";
import { useEditor } from "../StudioEditor";
import { Chip } from "./index";

const KINDS: Array<{ id: ClipLayout["kind"]; label: string; sub: string }> = [
  { id: "auto", label: "Auto", sub: "Shots decide; letterbox when none" },
  { id: "fill", label: "Fill", sub: "Crop to the frame" },
  { id: "fit", label: "Fit", sub: "Whole frame, background behind" },
  { id: "split", label: "Split", sub: "Two speakers stacked" },
  { id: "screenshare", label: "Screenshare", sub: "Screen on top, face below" },
];

const LABEL: Record<LayoutKind | "legacy", string> = {
  legacy: "Letterbox",
  fill: "Fill",
  fit: "Fit",
  split: "Split",
  screenshare: "Screenshare",
};

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * The Layout tab of the clip panel (mock-up 11): layout tiles, the fit
 * background, a source view with the crop boxes (orange, drag to override),
 * and this asset's shot list with manual overrides. Auto reframe fills
 * doc.shots in Phase 3; until then the list shows overrides only.
 */
export default function LayoutPanel({ assetId }: { assetId: string }) {
  const { doc, update, assets, outputTime, seek } = useEditor();
  const asset = assets.find((a) => a.id === assetId);
  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    return d;
  }, [assets]);
  const edl = useMemo(() => edlFromDoc(doc, durations), [doc, durations]);
  const loc = locate(edl, outputTime);
  const here = loc && loc.assetId === assetId ? loc : null;
  // The clip under the playhead when it is this asset's, else its first clip.
  const clip =
    doc.clips.find((c) => c.id === (here?.clipId ?? here?.assetId)) ?? doc.clips.find((c) => c.assetId === assetId);
  const clipId = clip?.id ?? assetId;
  const cur = doc.layout[clipId] ?? DEFAULT_LAYOUT;
  const srcT = here?.srcTime ?? clip?.srcIn ?? 0;
  const sw = asset?.width ?? 0;
  const sh = asset?.height ?? 0;
  const out = outputSize(doc.output.aspect, 1080);
  const lay = layoutAt(doc, clipId, assetId, srcT, sw, sh, out.width, out.height);

  const setLayout = (patch: Partial<ClipLayout>) => update((d) => setClipLayout(d, clipId, { ...cur, ...patch }));

  /* ---- source view, synced to the playhead while paused ---- */
  const vRef = useRef<HTMLVideoElement | null>(null);
  const src = fileUrl(asset?.proxyUrl ?? asset?.sourceUrl ?? null) ?? "";
  useEffect(() => {
    const v = vRef.current;
    if (v && Math.abs(v.currentTime - srcT) > 0.1) v.currentTime = srcT;
  }, [srcT]);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ k: number; x: number; y: number; px: number; py: number; ox: number; oy: number } | null>(null);
  const crops: Rect[] = lay.crops.map((r, k) => (drag && drag.k === k ? { ...r, x: drag.x, y: drag.y } : r));
  const onDown = (k: number) => (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ k, x: crops[k].x, y: crops[k].y, ox: crops[k].x, oy: crops[k].y, px: e.clientX, py: e.clientY });
  };
  const onMove = (e: ReactPointerEvent) => {
    const el = boxRef.current;
    if (!drag || !el) return;
    const r = el.getBoundingClientRect();
    const base = lay.crops[drag.k];
    const x = drag.ox + (e.clientX - drag.px) / r.width;
    const y = drag.oy + (e.clientY - drag.py) / r.height;
    setDrag({
      ...drag,
      x: Math.max(-0.5 + base.w / 2, Math.min(0.5 - base.w / 2, x)),
      y: Math.max(-0.5 + base.h / 2, Math.min(0.5 - base.h / 2, y)),
    });
  };
  const onUp = () => {
    if (!drag) return;
    const next = lay.crops.map((r, k) => (k === drag.k ? { ...r, x: drag.x, y: drag.y } : r));
    setDrag(null);
    const start = Math.max(lay.start, clip?.srcIn ?? 0, 0);
    const end = Math.min(lay.end, clip?.srcOut ?? Infinity, durations[assetId] ?? Infinity);
    if (lay.kind !== "legacy" && end > start && Number.isFinite(end)) {
      update((d) => setShotAdjust(d, assetId, { start, end, layout: lay.kind as LayoutKind, crops: next }));
    }
  };

  /* ---- shot list: auto shots and manual overrides, source order ---- */
  const rows = useMemo(() => {
    const list: Array<{ start: number; end: number; label: string; manual: boolean }> = [];
    for (const s of doc.shots[assetId] ?? []) list.push({ start: s.start, end: s.end, label: LABEL[s.layout], manual: false });
    for (const a of doc.shotAdjust[assetId] ?? []) {
      list.push({ start: a.start, end: a.end, label: `${LABEL[a.layout ?? "fill"]} · manual`, manual: true });
    }
    return list.sort((a, b) => a.start - b.start || Number(a.manual) - Number(b.manual));
  }, [doc.shots, doc.shotAdjust, assetId]);

  const srcAspect = sw > 0 && sh > 0 ? sw / sh : 16 / 9;

  return (
    <div className="lay">
      <div className="pnl-cards lay-tiles">
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`glass-sm pnl-card lay-tile${cur.kind === k.id ? " on" : ""}`}
            onClick={() => setLayout({ kind: k.id })}
          >
            <i className={`lay-ico lay-ico-${k.id}`} />
            <b>{k.label}</b>
            <div className="sub">{k.sub}</div>
          </button>
        ))}
      </div>
      {(cur.kind === "fit" || lay.kind === "fit") && (
        <div className="pnl-chiprow">
          <span className="mini">Fit background</span>
          {(["blur", "black", "color"] as const).map((b) => (
            <Chip key={b} on={cur.fitBg === b} onClick={() => setLayout({ fitBg: b })}>
              {b === "blur" ? "Blur" : b === "black" ? "Black" : "Color"}
            </Chip>
          ))}
          {cur.fitBg === "color" && (
            <input
              type="color"
              value={cur.bgColor ?? "#000000"}
              onChange={(e) => setLayout({ bgColor: e.target.value })}
            />
          )}
        </div>
      )}

      <div className="lay-body">
        <div className="glass-sm lay-source">
          <div className="lay-head">
            <b>
              Source {sw && sh ? `${sw}x${sh}` : ""} · {LABEL[lay.kind]}
              {lay.manual ? " · manual" : ""}
            </b>
            <button className="pnl-chip" disabled title="Auto reframe arrives with face tracking (Phase 3)">
              + Auto reframe
            </button>
          </div>
          <div className="lay-frame" ref={boxRef} style={{ aspectRatio: String(srcAspect) }}>
            {src && <video ref={vRef} src={src} muted playsInline preload="auto" />}
            {crops.map((r, k) => (
              <div
                key={k}
                className="lay-crop"
                style={{
                  left: `${(0.5 + r.x - r.w / 2) * 100}%`,
                  top: `${(0.5 + r.y - r.h / 2) * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
                onPointerDown={onDown(k)}
                onPointerMove={onMove}
                onPointerUp={onUp}
              />
            ))}
          </div>
          <div className="mini lay-legend">
            {lay.kind === "legacy"
              ? "Pick a layout to crop this clip for the output frame."
              : lay.kind === "fit"
                ? "Fit shows the whole frame; no crop to drag."
                : "Orange: crop, drag to override this shot."}
          </div>
        </div>

        <div className="glass-sm lay-shots">
          <b>Shots · {rows.length}</b>
          {rows.length === 0 && <div className="mini">No shots yet. Drag a crop to add a manual one.</div>}
          {rows.map((r, i) => (
            <div key={i} className="lay-row">
              <button
                className="lay-rowbtn"
                onClick={() => {
                  const t = toOutputTime(edl, assetId, r.start + 0.01);
                  if (t !== null) seek(t);
                }}
              >
                <span>{fmt(r.start)}</span>
                <span className={r.manual ? "lay-man" : ""}>{r.label}</span>
              </button>
              {r.manual && (
                <button
                  className="pnl-reset"
                  title="Remove this override"
                  onClick={() => update((d) => clearShotAdjust(d, assetId, r.start, r.end))}
                >
                  Reset
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
