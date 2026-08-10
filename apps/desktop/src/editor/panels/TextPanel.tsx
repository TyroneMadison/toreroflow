import { useState } from "react";
import type { TextAnim, TextItem, TextStyle } from "@toreroflow/core";
import { useEditor } from "../StudioEditor";
import { Chip, ColorField, HexField, SliderRow, SubPills } from "./index";

const FONT_STACKS: Array<{ label: string; value: string }> = [
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Impact", value: "Impact, 'Arial Black', sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Tahoma", value: "Tahoma, Geneva, sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', Tahoma, sans-serif" },
  { label: "Courier", value: "'Courier New', Courier, monospace" },
  { label: "Times", value: "'Times New Roman', Times, serif" },
];

const ANIMS: Array<{ id: TextAnim; label: string }> = [
  { id: "pop", label: "Pop" },
  { id: "emphasis", label: "Emphasis" },
  { id: "word", label: "Word" },
  { id: "wordpop", label: "Word pop" },
  { id: "typewriter", label: "Typewriter" },
  { id: "focus", label: "Focus" },
  { id: "slideup", label: "Slide up" },
  { id: "fade", label: "Fade" },
  { id: "none", label: "None" },
];

export const ALIGN_PATHS: Record<TextStyle["align"], string> = {
  left: "M4 6h16M4 12h10M4 18h13",
  center: "M4 6h16M7 12h10M6 18h12",
  right: "M4 6h16M10 12h10M7 18h13",
};

/** The panel for a selected text block: content, the style grid, animations. */
export default function TextPanel({ id }: { id: string }) {
  const { doc, update } = useEditor();
  const [tab, setTab] = useState<"style" | "in" | "out">("style");

  const item = doc.texts.find((t) => t.id === id);
  if (!item) return null;
  const s = item.style;

  const patchItem = (p: Partial<TextItem>) => {
    update((d) => ({
      ...d,
      texts: d.texts.map((t) => (t.id === id ? { ...t, ...p } : t)),
    }));
  };
  const patchStyle = (p: Partial<TextStyle>) => {
    update((d) => ({
      ...d,
      texts: d.texts.map((t) => (t.id === id ? { ...t, style: { ...t.style, ...p } } : t)),
    }));
  };

  const fontKnown = FONT_STACKS.some((f) => f.value === s.font);

  return (
    <div className="pnl">
      <h3>Text</h3>
      <SubPills
        tabs={[
          { id: "style", label: "Text style" },
          { id: "in", label: "Animate in" },
          { id: "out", label: "Animate out" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "style" && (
        <>
          <textarea
            className="field-in"
            rows={2}
            value={item.content}
            onChange={(e) => patchItem({ content: e.target.value })}
          />
          <div className="pnl-grid12">
            <div className="glass-sm pnl-card">
              <b>Font</b>
              <div className="pnl-chiprow">
                <select
                  className="field-in pnl-hex"
                  style={{ marginTop: 0, flex: 1 }}
                  value={s.font}
                  onChange={(e) => patchStyle({ font: e.target.value })}
                >
                  {!fontKnown && <option value={s.font}>{s.font}</option>}
                  {FONT_STACKS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <Chip on={s.bold} onClick={() => patchStyle({ bold: !s.bold })}>
                  B
                </Chip>
                <Chip on={s.italic} onClick={() => patchStyle({ italic: !s.italic })}>
                  I
                </Chip>
              </div>
            </div>

            <div className="glass-sm pnl-card">
              <b>Color</b>
              <ColorField value={s.color} onCommit={(hex) => patchStyle({ color: hex })} />
            </div>

            <div className="glass-sm pnl-card">
              <b>Size</b>
              <SliderRow min={12} max={96} value={s.size} def={48} onCommit={(v) => patchStyle({ size: v })} />
            </div>

            <div className="glass-sm pnl-card">
              <b>Letter space</b>
              <SliderRow min={-5} max={25} value={s.letterSpace} def={0} onCommit={(v) => patchStyle({ letterSpace: v })} />
            </div>

            <div className="glass-sm pnl-card">
              <b>Position</b>
              <SliderRow label="X" min={-100} max={100} value={s.x} def={0} onCommit={(v) => patchStyle({ x: v })} />
              <SliderRow label="Y" min={-100} max={100} value={s.y} def={0} onCommit={(v) => patchStyle({ y: v })} />
            </div>

            <div className="glass-sm pnl-card">
              <b>Case</b>
              <div className="pnl-chiprow">
                <Chip on={s.case === "upper"} onClick={() => patchStyle({ case: "upper" })}>Upper</Chip>
                <Chip on={s.case === "title"} onClick={() => patchStyle({ case: "title" })}>Title</Chip>
                <Chip on={s.case === "asis"} onClick={() => patchStyle({ case: "asis" })}>As is</Chip>
              </div>
            </div>

            <div className="glass-sm pnl-card">
              <b>Align</b>
              <div className="pnl-chiprow">
                {(Object.keys(ALIGN_PATHS) as Array<TextStyle["align"]>).map((a) => (
                  <Chip key={a} on={s.align === a} title={a} onClick={() => patchStyle({ align: a })}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d={ALIGN_PATHS[a]} />
                    </svg>
                  </Chip>
                ))}
              </div>
            </div>

            <div className="glass-sm pnl-card">
              <b>Shadow</b>
              <div className="pnl-chiprow">
                <Chip on={s.shadow.on} onClick={() => patchStyle({ shadow: { ...s.shadow, on: !s.shadow.on } })}>
                  {s.shadow.on ? "On" : "Off"}
                </Chip>
              </div>
              {s.shadow.on && (
                <>
                  <SliderRow label="OPA" min={0} max={100} value={s.shadow.opacity} def={60} onCommit={(v) => patchStyle({ shadow: { ...s.shadow, opacity: v } })} />
                  <SliderRow label="INT" min={0} max={100} value={s.shadow.intensity} def={50} onCommit={(v) => patchStyle({ shadow: { ...s.shadow, intensity: v } })} />
                  <SliderRow label="DST" min={0} max={30} value={s.shadow.distance} def={4} onCommit={(v) => patchStyle({ shadow: { ...s.shadow, distance: v } })} />
                </>
              )}
            </div>

            <div className="glass-sm pnl-card">
              <b>Outline</b>
              <div className="pnl-chiprow">
                <Chip on={s.outline.on} onClick={() => patchStyle({ outline: { ...s.outline, on: !s.outline.on } })}>
                  {s.outline.on ? "On" : "Off"}
                </Chip>
              </div>
              {s.outline.on && (
                <>
                  <SliderRow label="SIZE" min={0} max={20} value={s.outline.size} def={6} onCommit={(v) => patchStyle({ outline: { ...s.outline, size: v } })} />
                  <ColorField value={s.outline.color} onCommit={(hex) => patchStyle({ outline: { ...s.outline, color: hex } })} />
                </>
              )}
            </div>

            <div className="glass-sm pnl-card">
              <b>Glow</b>
              <div className="sub">Preview only; glow does not reach the export.</div>
              <div className="pnl-chiprow">
                <Chip on={s.glow.on} onClick={() => patchStyle({ glow: { ...s.glow, on: !s.glow.on } })}>
                  {s.glow.on ? "On" : "Off"}
                </Chip>
              </div>
              {s.glow.on && (
                <>
                  <SliderRow label="SPR" min={0} max={100} value={s.glow.spread} def={50} onCommit={(v) => patchStyle({ glow: { ...s.glow, spread: v } })} />
                  <HexField value={s.glow.color} onCommit={(hex) => patchStyle({ glow: { ...s.glow, color: hex } })} />
                </>
              )}
            </div>

            <div className="glass-sm pnl-card">
              <b>Background</b>
              <div className="pnl-chiprow">
                <Chip on={s.background.on} onClick={() => patchStyle({ background: { ...s.background, on: !s.background.on } })}>
                  {s.background.on ? "On" : "Off"}
                </Chip>
              </div>
              {s.background.on && (
                <>
                  <div className="pnl-chiprow">
                    {(["rounded", "square", "fit", "full"] as const).map((shape) => (
                      <Chip key={shape} on={s.background.shape === shape} onClick={() => patchStyle({ background: { ...s.background, shape } })}>
                        {shape[0].toUpperCase() + shape.slice(1)}
                      </Chip>
                    ))}
                  </div>
                  <SliderRow label="OPA" min={0} max={100} value={s.background.opacity} def={80} onCommit={(v) => patchStyle({ background: { ...s.background, opacity: v } })} />
                  <SliderRow label="SIZE" min={0} max={100} value={s.background.size} def={50} onCommit={(v) => patchStyle({ background: { ...s.background, size: v } })} />
                  <ColorField value={s.background.color} onCommit={(hex) => patchStyle({ background: { ...s.background, color: hex } })} />
                </>
              )}
            </div>
          </div>
        </>
      )}

      {(tab === "in" || tab === "out") && (
        <div className="pnl-chiprow">
          {ANIMS.map((a) => {
            const current = tab === "in" ? item.animIn : item.animOut;
            return (
              <Chip
                key={a.id}
                on={current === a.id}
                onClick={() => patchItem(tab === "in" ? { animIn: a.id } : { animOut: a.id })}
              >
                {a.label}
              </Chip>
            );
          })}
        </div>
      )}
    </div>
  );
}
