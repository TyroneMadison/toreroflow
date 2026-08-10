import { useState } from "react";
import type { ClipFx, ColorAdjust, ZoomItem } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useEditor } from "../StudioEditor";
import { Chip, SliderRow, SubPills } from "./index";

const DEFAULT_FX: ClipFx = {
  zoom: 1,
  x: 0,
  y: 0,
  rotate: 0,
  volume: 100,
  color: { b: 0, c: 0, s: 0, w: 0 },
};

const ZOOM_CARDS: Array<{ kind: ZoomItem["kind"]; title: string; sub: string }> = [
  { kind: "pushin", title: "Push in", sub: "Slow crop in or pull back" },
  { kind: "punchin", title: "Punch in", sub: "Hold a closer crop" },
  { kind: "quickzoom", title: "Quick zoom", sub: "Snap zoom at the playhead" },
];

const SIZES: Array<{ size: ZoomItem["size"]; label: string }> = [
  { size: "s", label: "Small" },
  { size: "m", label: "Medium" },
  { size: "l", label: "Large" },
];

const COLOR_CARDS: Array<{ key: keyof ColorAdjust; title: string; lab: string }> = [
  { key: "b", title: "Brightness", lab: "B" },
  { key: "c", title: "Contrast", lab: "CON" },
  { key: "s", title: "Saturation", lab: "SAT" },
  { key: "w", title: "Warmth", lab: "TMP" },
];

/** The panel for a selected clip: zoom moves, transform and volume, colour. */
export default function ClipPanel({ assetId }: { assetId: string }) {
  const { doc, update, assets, outputTime, runAction, project, refreshAssets } = useEditor();
  const [tab, setTab] = useState<"quick" | "adjust" | "color">("quick");
  const [isolating, setIsolating] = useState<"voice" | "instrumental" | null>(null);

  const isolate = async (mode: "voice" | "instrumental") => {
    setIsolating(mode);
    try {
      await api.post(`/edit-projects/${project.id}/isolate`, { assetId, mode });
      // The job runs at about the clip's own length; the drawer shows the
      // asset as processing the next time assets refresh.
      setTimeout(() => void refreshAssets().catch(() => {}), 1500);
    } catch {
      setIsolating(null);
      return;
    }
    setTimeout(() => setIsolating(null), 4000);
  };

  const asset = assets.find((a) => a.id === assetId);
  const fx = doc.clipFx[assetId] ?? DEFAULT_FX;

  const setFx = (p: Partial<ClipFx>) => {
    update((d) => ({
      ...d,
      clipFx: { ...d.clipFx, [assetId]: { ...(d.clipFx[assetId] ?? DEFAULT_FX), ...p } },
    }));
  };
  const setColor = (key: keyof ColorAdjust, v: number) => {
    update((d) => {
      const cur = d.clipFx[assetId] ?? DEFAULT_FX;
      return {
        ...d,
        clipFx: { ...d.clipFx, [assetId]: { ...cur, color: { ...cur.color, [key]: v } } },
      };
    });
  };
  const addZoom = (kind: ZoomItem["kind"], size: ZoomItem["size"]) => {
    update((d) => ({
      ...d,
      zooms: [...d.zooms, { id: crypto.randomUUID(), at: outputTime, kind, size }],
    }));
  };

  return (
    <div className="pnl">
      <h3>{asset?.originalName ?? "Clip"}</h3>
      <SubPills
        tabs={[
          { id: "quick", label: "Quick actions" },
          { id: "adjust", label: "Clip adjustments" },
          { id: "color", label: "Color" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "quick" && (
        <div className="pnl-cards">
          {ZOOM_CARDS.map((z) => (
            <div key={z.kind} className="glass-sm pnl-card">
              <b>{z.title}</b>
              <div className="sub">{z.sub}</div>
              <div className="pnl-chiprow">
                {SIZES.map((s) => (
                  <Chip key={s.size} onClick={() => addZoom(z.kind, s.size)}>
                    {s.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "adjust" && (
        <div className="pnl-cards">
          <div className="glass-sm pnl-card">
            <b>Zoom</b>
            <SliderRow
              label="Z"
              min={0.5}
              max={3}
              step={0.01}
              digits={2}
              value={fx.zoom}
              def={1}
              onCommit={(v) => setFx({ zoom: v })}
            />
          </div>
          <div className="glass-sm pnl-card">
            <b>Position</b>
            <SliderRow label="X" min={-100} max={100} value={fx.x} def={0} onCommit={(v) => setFx({ x: v })} />
            <SliderRow label="Y" min={-100} max={100} value={fx.y} def={0} onCommit={(v) => setFx({ y: v })} />
          </div>
          <div className="glass-sm pnl-card">
            <b>Rotate</b>
            <SliderRow
              label="ROT"
              min={-180}
              max={180}
              value={fx.rotate}
              def={0}
              onCommit={(v) => setFx({ rotate: v })}
            />
          </div>
          <div className="glass-sm pnl-card">
            <b>Volume</b>
            <SliderRow
              label="VOL"
              min={0}
              max={200}
              value={fx.volume}
              def={100}
              onCommit={(v) => setFx({ volume: v })}
            />
            <button
              className="btn ghost"
              style={{ marginTop: 8, width: "100%", fontSize: 11.5 }}
              title="Puts this clip's sound on the audio lane and mutes the clip, so it can be moved, trimmed, or deleted on its own. Ctrl+Shift+S does the same."
              onClick={() => runAction("detachAudio")}
            >
              Detach audio
            </button>
          </div>
          <div className="glass-sm pnl-card">
            <b>Isolate voice</b>
            <div className="sub">
              Splits this clip's sound with AI. The result lands in the Audio
              drawer in about the clip's own length; the clip itself is never
              changed.
            </div>
            <div className="pnl-chiprow" style={{ marginTop: 8 }}>
              <Chip
                onClick={() => void isolate("voice")}
                title="Keep the speech, drop music and background noise"
              >
                {isolating === "voice" ? "Queued…" : "Keep voice"}
              </Chip>
              <Chip
                onClick={() => void isolate("instrumental")}
                title="Drop the speech, keep music and background"
              >
                {isolating === "instrumental" ? "Queued…" : "Remove voice"}
              </Chip>
            </div>
          </div>
        </div>
      )}

      {tab === "color" && (
        <div className="pnl-cards">
          {COLOR_CARDS.map((c) => (
            <div key={c.key} className="glass-sm pnl-card">
              <b>{c.title}</b>
              <SliderRow
                label={c.lab}
                min={-100}
                max={100}
                value={fx.color[c.key]}
                def={0}
                onCommit={(v) => setColor(c.key, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
