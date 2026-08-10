import { useEffect, useState } from "react";
import { useEditor } from "../StudioEditor";
import UniversalPanel from "./UniversalPanel";
import ClipPanel from "./ClipPanel";
import TextPanel from "./TextPanel";
import "./panels.css";

export { ClipsDrawer, AudioDrawer, GraphicsDrawer } from "./Drawers";

/**
 * The context-sensitive panel area under the timeline. What it shows follows
 * the selection: nothing selected is the universal panel, a clip gets the
 * clip panel, a text block the text panel, and the overlay kinds get a
 * compact strip.
 */
export function PanelArea() {
  const { selection } = useEditor();
  if (!selection) return <UniversalPanel />;
  if (selection.kind === "clip") return <ClipPanel assetId={selection.assetId} />;
  if (selection.kind === "text") return <TextPanel id={selection.id} />;
  return <OverlayStrip kind={selection.kind} id={selection.id} />;
}

export default PanelArea;

/* ---- shared pieces used by every panel ---- */

export function SubPills<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="pnl-pills">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`pnl-pill${t.id === value ? " on" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One slider row: label, range, readout, Reset. The drag holds a local value
 * and commits on release, so a gesture is one undo step, not forty.
 */
export function SliderRow({
  label,
  min,
  max,
  step = 1,
  value,
  def,
  onCommit,
  digits = 0,
}: {
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  def: number;
  onCommit: (v: number) => void;
  digits?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <div className="pnl-sliderline">
      {label && <span className="lab">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="pnl-val">{local.toFixed(digits)}</span>
      <button
        className="pnl-reset"
        onClick={() => {
          setLocal(def);
          if (value !== def) onCommit(def);
        }}
      >
        Reset
      </button>
    </div>
  );
}

export function Chip({
  on,
  disabled,
  title,
  onClick,
  children,
}: {
  on?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`pnl-chip${on ? " on" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A hex colour field that commits only when the text is a valid #RRGGBB. */
export function HexField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (hex: string) => void;
}) {
  const [raw, setRaw] = useState(value);
  useEffect(() => setRaw(value), [value]);
  return (
    <input
      className="field-in pnl-hex"
      value={raw}
      spellCheck={false}
      onChange={(e) => {
        const v = e.target.value.trim();
        setRaw(v);
        const hex = v.startsWith("#") ? v : `#${v}`;
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) onCommit(hex.toUpperCase());
      }}
    />
  );
}

export const SWATCHES = [
  "#FFFFFF",
  "#000000",
  "#FF6F61",
  "#FF9A73",
  "#F5C518",
  "#57D6A0",
  "#4FA3FF",
  "#9B6CFF",
  "#FF6FB5",
  "#FF2D55",
  "#FF8A3C",
  "#9AA0A6",
];

/* ---- HSL to hex and back, plain math so the sliders need no dependency ---- */

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const n = parseInt(m ? m[1] : "FFFFFF", 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const mm = ln - c / 2;
  const to = (v: number) =>
    Math.round((v + mm) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`.toUpperCase();
}

/**
 * One full colour control: the swatch row, hue/saturation/lightness sliders,
 * and the hex field, all bound to one committed #RRGGBB value. The doc model
 * stores opaque hex only, so opacity stays with the style's own OPA sliders.
 * Slider drags hold a local colour and commit on release, matching SliderRow,
 * and the stored hex stays authoritative so integer HSL rounding never
 * rewrites a colour the operator did not touch.
 */
export function ColorField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (hex: string) => void;
}) {
  const [c, setC] = useState(() => ({ ...hexToHsl(value), hex: value.toUpperCase() }));
  useEffect(() => {
    setC((cur) => (cur.hex === value.toUpperCase() ? cur : { ...hexToHsl(value), hex: value.toUpperCase() }));
  }, [value]);
  const move = (k: "h" | "s" | "l", v: number) =>
    setC((cur) => {
      const n = { ...cur, [k]: v };
      return { ...n, hex: hslToHex(n.h, n.s, n.l) };
    });
  const commit = () => {
    if (c.hex !== value.toUpperCase()) onCommit(c.hex);
  };
  const rows: Array<{ key: "h" | "s" | "l"; max: number; val: number; bg?: string }> = [
    { key: "h", max: 360, val: c.h },
    { key: "s", max: 100, val: c.s, bg: `linear-gradient(90deg,hsl(${c.h},0%,${c.l}%),hsl(${c.h},100%,${c.l}%))` },
    { key: "l", max: 100, val: c.l, bg: `linear-gradient(90deg,#000,hsl(${c.h},${c.s}%,50%),#fff)` },
  ];
  return (
    <>
      <div className="pnl-swatches">
        {SWATCHES.map((sw) => (
          <button
            key={sw}
            className={`pnl-swatch${c.hex === sw ? " on" : ""}`}
            style={{ background: sw }}
            title={sw}
            onClick={() => onCommit(sw)}
          />
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="pnl-sliderline">
          <span className="lab">{r.key.toUpperCase()}</span>
          <input
            type="range"
            className={`cf-range${r.key === "h" ? " cf-hue" : ""}`}
            min={0}
            max={r.max}
            value={r.val}
            style={r.bg ? { background: r.bg } : undefined}
            onChange={(e) => move(r.key, Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span className="pnl-val">{r.val}</span>
        </div>
      ))}
      <HexField value={c.hex} onCommit={onCommit} />
    </>
  );
}

/* ---- the compact strip for broll, audio, graphic selections ---- */

function OverlayStrip({ kind, id }: { kind: "broll" | "graphic" | "audio"; id: string }) {
  const { doc, update, assets, setSelection } = useEditor();

  const item =
    kind === "broll"
      ? doc.broll.find((b) => b.id === id)
      : kind === "audio"
        ? doc.audio.find((a) => a.id === id)
        : doc.graphics.find((g) => g.id === id);
  if (!item) return null;
  const name =
    assets.find((a) => a.id === item.assetId)?.originalName ??
    (kind === "audio" ? "Audio" : kind === "broll" ? "B-roll" : "Graphic");

  const patch = (p: Record<string, number>) => {
    update((d) => {
      if (kind === "broll")
        return { ...d, broll: d.broll.map((b) => (b.id === id ? { ...b, ...p } : b)) };
      if (kind === "audio")
        return { ...d, audio: d.audio.map((a) => (a.id === id ? { ...a, ...p } : a)) };
      return { ...d, graphics: d.graphics.map((g) => (g.id === id ? { ...g, ...p } : g)) };
    });
  };
  const remove = () => {
    update((d) => {
      if (kind === "broll") return { ...d, broll: d.broll.filter((b) => b.id !== id) };
      if (kind === "audio") return { ...d, audio: d.audio.filter((a) => a.id !== id) };
      return { ...d, graphics: d.graphics.filter((g) => g.id !== id) };
    });
    setSelection(null);
  };

  return (
    <div className="pnl">
      <div className="glass-sm pnl-strip">
        <span className="name" title={name}>
          {name}
        </span>
        {kind !== "graphic" && (
          <SliderRow
            label="Volume"
            min={0}
            max={200}
            value={(item as { volume: number }).volume}
            def={100}
            onCommit={(v) => patch({ volume: v })}
          />
        )}
        {kind === "graphic" && (
          <>
            <SliderRow
              label="Scale"
              min={0.25}
              max={3}
              step={0.01}
              digits={2}
              value={(item as { scale: number }).scale}
              def={1}
              onCommit={(v) => patch({ scale: v })}
            />
            <SliderRow
              label="Opacity"
              min={0}
              max={100}
              value={(item as { opacity: number }).opacity}
              def={100}
              onCommit={(v) => patch({ opacity: v })}
            />
          </>
        )}
        <button className="dangerbtn" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}
