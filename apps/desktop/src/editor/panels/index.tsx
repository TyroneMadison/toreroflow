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
