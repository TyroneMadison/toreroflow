import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  CAPTION_TEMPLATES,
  DEFAULT_CAPTION_STYLE,
  FONTS,
  applyTemplate,
  captionKaraoke,
  chunksFor,
  editedWords,
  edlFromDoc,
  outputWords,
  type CaptionStyle,
  type TextStyle,
  type Word,
} from "@toreroflow/core";
import { useEditor } from "../StudioEditor";
import { Chip, ColorField, HexField, SliderRow } from "../panels";
import { ALIGN_PATHS } from "../panels/TextPanel";
import "./CaptionStep.css";

/**
 * Caption animations; ids land in captions.style.animation and every one of
 * them maps to a real ASS effect in captionsToAss. Word pop is gone on
 * purpose: per-word transforms have no honest caption-level ASS form.
 */
const ANIMS: Array<{ id: string; label: string }> = [
  { id: "pop", label: "Pop" },
  { id: "karaoke", label: "Karaoke" },
  { id: "emphasis", label: "Emphasis" },
  { id: "typewriter", label: "Typewriter" },
  { id: "focus", label: "Focus" },
  { id: "slideup", label: "Slide up" },
  { id: "fade", label: "Fade" },
  { id: "none", label: "None" },
];

interface CustomTemplate {
  id: string;
  label: string;
  style: CaptionStyle;
}

/** Bare bundled-font names get a generic fallback; css stacks pass through. */
function fontStack(font: string): string {
  if (font.includes(",")) return font;
  const generic = font.includes("Serif") ? "serif" : font.includes("Mono") ? "monospace" : "sans-serif";
  return `'${font}', ${generic}`;
}

/** A template tile's look, built from its style merged over the defaults. */
function tileCss(style: Partial<CaptionStyle>): CSSProperties {
  const s = { ...DEFAULT_CAPTION_STYLE, ...style };
  const shadows: string[] = [];
  if (s.outline.on && s.outline.size > 0) {
    const o = Math.max(1, Math.round(s.outline.size / 3));
    const c = s.outline.color;
    shadows.push(`-${o}px 0 0 ${c}`, `${o}px 0 0 ${c}`, `0 -${o}px 0 ${c}`, `0 ${o}px 0 ${c}`);
  }
  if (s.shadow.on) shadows.push(`0 2px 5px rgba(0,0,0,${(s.shadow.opacity / 100).toFixed(2)})`);
  if (s.glow.on) shadows.push(`0 0 8px ${s.glow.color}`);
  return {
    fontFamily: fontStack(s.font),
    fontWeight: s.bold ? 800 : 500,
    fontStyle: s.italic ? "italic" : "normal",
    color: s.color,
    letterSpacing: s.letterSpace ? s.letterSpace * 0.6 : undefined,
    textTransform: s.case === "upper" ? "uppercase" : s.case === "title" ? "capitalize" : "none",
    textShadow: shadows.length > 0 ? shadows.join(", ") : undefined,
    ...(s.background.on
      ? {
          background: s.background.color,
          padding: "3px 8px",
          borderRadius: s.background.shape === "square" ? 2 : 8,
        }
      : {}),
  };
}

function Section({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: string | null;
  onToggle: (id: string | null) => void;
  children: ReactNode;
}) {
  const is = open === id;
  return (
    <div className="card glass cst-sec">
      <button className="cst-sechead" onClick={() => onToggle(is ? null : id)}>
        <h3>{title}</h3>
        <svg className={`cst-chev${is ? " open" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {is && <div className="cst-secbody">{children}</div>}
    </div>
  );
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** Step 3: Caption Style. Templates, animation, the style grid, chunk breaks. */
export default function CaptionStep() {
  const { project, doc, update, assets } = useEditor();
  const [open, setOpen] = useState<string | null>("templates");
  const s = doc.captions.style;

  const patchStyle = (p: Partial<CaptionStyle>) =>
    update((d) => ({
      ...d,
      captions: { ...d.captions, style: { ...d.captions.style, ...p } },
    }));

  /* ---- custom templates, saved per client in localStorage ---- */

  const storeKey = `tf-caption-customs-${project.clientId}`;
  const [customs, setCustoms] = useState<CustomTemplate[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "[]") as CustomTemplate[];
    } catch {
      return [];
    }
  });
  const saveCustoms = (list: CustomTemplate[]) => {
    setCustoms(list);
    try {
      localStorage.setItem(storeKey, JSON.stringify(list));
    } catch {
      /* storage full or blocked; the doc itself is unaffected */
    }
  };
  const addCustom = () => {
    const n = customs.reduce((m, c) => Math.max(m, Number(c.id.replace("custom-", "")) || 0), 0) + 1;
    const style = JSON.parse(JSON.stringify(s)) as CaptionStyle;
    // A custom carries an explicit animation: applying it later cannot fall
    // back to a template lookup, because customs are not in CAPTION_TEMPLATES.
    style.animation ??= captionKaraoke(doc.captions) ? "karaoke" : "none";
    saveCustoms([...customs, { id: `custom-${n}`, label: `Custom ${n}`, style }]);
  };
  const applyCustom = (c: CustomTemplate) =>
    update((d) => ({
      ...d,
      captions: {
        ...d.captions,
        enabled: true,
        template: c.id,
        style: JSON.parse(JSON.stringify(c.style)) as CaptionStyle,
      },
    }));

  /* ---- caption chunks of the current doc, output time ---- */

  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    return d;
  }, [assets]);
  const chunks = useMemo(() => {
    const edl = edlFromDoc(doc, durations);
    const byAsset: Record<string, Word[]> = {};
    for (const a of assets) {
      if (a.kind === "clip" && a.words) byAsset[a.id] = editedWords(a.words, doc.wordEdits[a.id] ?? {});
    }
    return chunksFor(outputWords(edl, byAsset), s.wordsPerLine, s.lines);
  }, [doc, durations, assets, s.wordsPerLine, s.lines]);

  const setBreak = (chunkIndex: number, text: string) =>
    update((d) => ({
      ...d,
      captions: {
        ...d.captions,
        breaks: [...d.captions.breaks.filter((b) => b.chunkIndex !== chunkIndex), { chunkIndex, text }],
      },
    }));
  const clearBreak = (chunkIndex: number) =>
    update((d) => ({
      ...d,
      captions: { ...d.captions, breaks: d.captions.breaks.filter((b) => b.chunkIndex !== chunkIndex) },
    }));

  const fontKnown = FONTS.includes(s.font);

  return (
    <div className="cst">
      <Section id="templates" title="Templates" open={open} onToggle={setOpen}>
        <div className="cst-tiles">
          {CAPTION_TEMPLATES.map((t) => {
            const active =
              t.id === "none"
                ? !doc.captions.enabled
                : doc.captions.enabled && doc.captions.template === t.id;
            return (
              <button
                key={t.id}
                className={`cst-tile${active ? " on" : ""}${t.id === "none" ? " cst-tile-none" : ""}`}
                onClick={() => update((d) => applyTemplate(d, t.id))}
              >
                <span className="cst-tile-label" style={t.id === "none" ? undefined : tileCss(t.style)}>
                  {t.label}
                </span>
              </button>
            );
          })}
          {customs.map((c) => (
            <button
              key={c.id}
              className={`cst-tile${doc.captions.enabled && doc.captions.template === c.id ? " on" : ""}`}
              onClick={() => applyCustom(c)}
            >
              <span className="cst-tile-label" style={tileCss(c.style)}>
                {c.label}
              </span>
              <span
                className="cst-tile-x"
                title="Delete this template"
                onClick={(e) => {
                  e.stopPropagation();
                  saveCustoms(customs.filter((x) => x.id !== c.id));
                }}
              >
                x
              </span>
            </button>
          ))}
        </div>
        <button className="btn ghost cst-savetpl" onClick={addCustom}>
          + Save current settings as a template
        </button>
      </Section>

      <Section id="animation" title="Animation" open={open} onToggle={setOpen}>
        <div className="pnl-chiprow">
          {ANIMS.map((a) => (
            <Chip
              key={a.id}
              on={(s.animation ?? "none") === a.id}
              onClick={() => patchStyle({ animation: a.id })}
            >
              <span className={`cst-anim cst-anim-${a.id}`} data-word={a.label}>
                {a.label}
              </span>
            </Chip>
          ))}
        </div>
      </Section>

      <Section id="style" title="Caption style" open={open} onToggle={setOpen}>
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
                {FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
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
            <SliderRow label="Y" min={-100} max={100} value={s.y} def={30} onCommit={(v) => patchStyle({ y: v })} />
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
            <b>Words per line</b>
            <div className="pnl-chiprow">
              {([1, 2, 3, 4, 5] as const).map((n) => (
                <Chip key={n} on={s.wordsPerLine === n} onClick={() => patchStyle({ wordsPerLine: n })}>
                  {n}
                </Chip>
              ))}
            </div>
          </div>

          <div className="glass-sm pnl-card">
            <b>Lines</b>
            <div className="pnl-chiprow">
              {([1, 2] as const).map((n) => (
                <Chip key={n} on={s.lines === n} onClick={() => patchStyle({ lines: n })}>
                  {n}
                </Chip>
              ))}
            </div>
          </div>

          <div className="glass-sm pnl-card">
            <b>Accent color</b>
            <div className="sub">The karaoke highlight.</div>
            <ColorField value={s.accentColor} onCommit={(hex) => patchStyle({ accentColor: hex })} />
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
      </Section>

      <Section id="breaks" title="Caption breaks" open={open} onToggle={setOpen}>
        <div className="sub">Fix what a caption says at each beat. Timing stays with the words.</div>
        {chunks.length === 0 && (
          <div className="sub" style={{ marginTop: 10 }}>
            No transcript words yet. Captions appear once your clips finish processing.
          </div>
        )}
        <div className="cst-breaks">
          {chunks.map((c, i) => {
            const br = doc.captions.breaks.find((b) => b.chunkIndex === i);
            return (
              <div key={i} className="cst-break">
                <span className="mini cst-breaktime">
                  {fmt(c.start)} - {fmt(c.end)}
                </span>
                <input
                  className="field-in"
                  value={br ? br.text : c.text.replace(/\n/g, " ")}
                  onChange={(e) => setBreak(i, e.target.value)}
                />
                <button className="pnl-reset" disabled={!br} onClick={() => clearBreak(i)}>
                  Reset
                </button>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
