import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CAPTION_TEMPLATES,
  ZOOM,
  chunksFor,
  editedWords,
  edlFromDoc,
  locate,
  outputDuration,
  outputWords,
  type ColorAdjust,
  type TextStyle,
  type Word,
} from "@toreroflow/core";
import { fileUrl } from "../lib/api";
import { useEditor, type EditAssetInfo } from "./StudioEditor";
import "./PhonePreview.css";

/** Stage width in px; must match .pv-screen in PhonePreview.css. */
const STAGE_W = 300;
/** The render target is 1080 wide, so on-stage text scales down by this. */
const TEXT_SCALE = STAGE_W / 1080;

interface Props {
  /** Bumped by the editor's seek(); the target time rides in seekTo. */
  seekN: number;
  seekTo: { current: number };
  /** Feeds the editor's outputTime state from the playback clock. */
  onClock: (t: number) => void;
}

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** #RRGGBB plus an opacity percent as an 8-digit hex color. */
function hexAlpha(hex: string, opacityPct: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(Math.max(0, Math.min(100, opacityPct)) * 2.55)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/**
 * Universal plus per-clip color as one CSS filter. Warmth is approximated
 * with a light sepia wash hue-rotated toward orange (warm) or blue (cool),
 * kept subtle on purpose; the render's eq filter is the real thing.
 */
function colorFilter(u: ColorAdjust, p?: ColorAdjust): string {
  const b = u.b + (p?.b ?? 0);
  const c = u.c + (p?.c ?? 0);
  const s = u.s + (p?.s ?? 0);
  const w = u.w + (p?.w ?? 0);
  const parts = [
    `brightness(${(1 + b / 200).toFixed(3)})`,
    `contrast(${(1 + c / 200).toFixed(3)})`,
    `saturate(${(1 + s / 200).toFixed(3)})`,
  ];
  if (w !== 0) {
    parts.push(`sepia(${(Math.abs(w) / 400).toFixed(3)})`);
    parts.push(`hue-rotate(${w > 0 ? (-w * 0.05).toFixed(1) : "180"}deg)`);
  }
  return parts.join(" ");
}

/**
 * Outline, shadow, and glow approximated as stacked text-shadows, "none"
 * when all three are off so the style really turns them off.
 */
function textShadowFor(s: TextStyle): string {
  const parts: string[] = [];
  if (s.outline.on) {
    const r = Math.max(1, s.outline.size * TEXT_SCALE);
    for (const [dx, dy] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [r, r],
      [r, -r],
      [-r, r],
      [-r, -r],
    ]) {
      parts.push(`${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 ${s.outline.color}`);
    }
  }
  if (s.shadow.on) {
    const d = Math.max(1, s.shadow.distance * TEXT_SCALE * 2);
    const blur = Math.max(1, s.shadow.intensity * TEXT_SCALE * 0.3);
    parts.push(`0 ${d.toFixed(1)}px ${blur.toFixed(1)}px ${hexAlpha("#000000", s.shadow.opacity)}`);
  }
  if (s.glow.on) {
    const spread = Math.max(2, s.glow.spread * TEXT_SCALE * 0.5);
    parts.push(`0 0 ${spread.toFixed(1)}px ${s.glow.color}`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** Minimal on-stage styling for a text overlay or the caption line. */
function overlayCss(x: number, y: number, s: TextStyle): CSSProperties {
  return {
    left: `calc(50% + ${x}%)`,
    top: `calc(50% + ${y}%)`,
    fontFamily: s.font,
    fontSize: Math.max(8, s.size * TEXT_SCALE),
    color: s.color,
    textShadow: textShadowFor(s),
    fontWeight: s.bold ? 800 : 500,
    fontStyle: s.italic ? "italic" : "normal",
    textAlign: s.align,
    letterSpacing: s.letterSpace ? s.letterSpace * TEXT_SCALE : undefined,
    textTransform:
      s.case === "upper" ? "uppercase" : s.case === "title" ? "capitalize" : "none",
    ...(s.background.on
      ? {
          background: hexAlpha(s.background.color, s.background.opacity),
          padding: "3px 8px",
          borderRadius: s.background.shape === "square" ? 2 : 8,
        }
      : {}),
  };
}

export default function PhonePreview({ seekN, seekTo, onClock }: Props) {
  const { doc, assets, outputTime, playing, setPlaying, undo, redo, canUndo, canRedo, seek } =
    useEditor();

  const [safe, setSafe] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const segRef = useRef(0);
  const pendingSrcSeek = useRef<number | null>(null);
  const playingRef = useRef(playing);
  const outputTimeRef = useRef(outputTime);
  useEffect(() => {
    outputTimeRef.current = outputTime;
  }, [outputTime]);

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
  const segStarts = useMemo(() => {
    let t = 0;
    return edl.map((s) => {
      const at = t;
      t += s.srcOut - s.srcIn;
      return at;
    });
  }, [edl]);

  const srcOf = useCallback(
    (assetId: string): string => {
      const a = byId[assetId];
      return fileUrl(a?.proxyUrl ?? a?.sourceUrl ?? null) ?? "";
    },
    [byId],
  );

  /** Points the video element at a segment, swapping src when the asset changes. */
  const goToSegment = useCallback(
    (i: number, srcTime?: number) => {
      const v = videoRef.current;
      const seg = edl[i];
      if (!v || !seg) return;
      segRef.current = i;
      const t = srcTime ?? seg.srcIn;
      const src = srcOf(seg.assetId);
      if (!src) return;
      if (v.src !== src) {
        pendingSrcSeek.current = t;
        v.src = src;
        v.load();
      } else {
        v.currentTime = t;
        if (playingRef.current) void v.play().catch(() => {});
      }
    },
    [edl, srcOf],
  );

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (pendingSrcSeek.current !== null) {
      v.currentTime = pendingSrcSeek.current;
      pendingSrcSeek.current = null;
    }
    if (playingRef.current) void v.play().catch(() => {});
  }, []);

  // External seeks: the editor bumps seekN with the target in seekTo.
  useEffect(() => {
    if (seekN === 0) return;
    const t = Math.min(seekTo.current, Math.max(0, total - 0.001));
    const loc = total > 0 ? locate(edl, t) : null;
    if (loc) goToSegment(loc.segIndex, loc.srcTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekN]);

  // Position the element on mount and whenever the cut changes while paused.
  useEffect(() => {
    if (playingRef.current || total <= 0) return;
    const t = Math.min(outputTimeRef.current, total - 0.001);
    const loc = locate(edl, Math.max(0, t));
    if (loc) goToSegment(loc.segIndex, loc.srcTime);
  }, [edl, total, goToSegment]);

  // The playback loop: rAF reads video.currentTime, maps it to output time,
  // hops to the next EDL segment at each srcOut, pauses at the output end.
  useEffect(() => {
    playingRef.current = playing;
    const v = videoRef.current;
    if (!v) return;
    if (!playing) {
      v.pause();
      return;
    }
    if (edl.length === 0 || total <= 0) {
      setPlaying(false);
      return;
    }
    if (outputTimeRef.current >= total - 0.01) {
      onClock(0);
      goToSegment(0);
    }
    void v.play().catch(() => {});
    let raf = 0;
    const tick = () => {
      const seg = edl[segRef.current];
      if (!seg) {
        setPlaying(false);
        return;
      }
      if (pendingSrcSeek.current === null) {
        const src = v.currentTime;
        if (src >= seg.srcOut - 0.02 || v.ended) {
          if (segRef.current + 1 < edl.length) {
            goToSegment(segRef.current + 1);
          } else {
            v.pause();
            onClock(total);
            setPlaying(false);
            return;
          }
        } else {
          const at = segStarts[segRef.current] ?? 0;
          onClock(at + Math.max(0, src - seg.srcIn));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, edl, segStarts, total, goToSegment, onClock, setPlaying]);

  // Volume follows the active clip's fx. The element stays unmuted.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const seg = edl[segRef.current];
    const vol = seg ? (doc.clipFx[seg.assetId]?.volume ?? 100) : 100;
    v.volume = Math.max(0, Math.min(1, vol / 100));
    v.muted = false;
  }, [doc, edl, outputTime]);

  // Overlay media (b-roll video, audio items) mount only inside their window
  // and follow the master clock: reseek on drift, play while playing, pause
  // otherwise. outputTime ticks every frame during playback, so this effect
  // is the per-frame sync.
  const overlayMedia = useRef(new Map<string, HTMLMediaElement>());
  const regMedia = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) overlayMedia.current.set(id, el);
    else overlayMedia.current.delete(id);
  };
  const clampT = total > 0 ? Math.min(Math.max(0, outputTime), total - 0.001) : 0;
  useEffect(() => {
    for (const item of [...doc.broll, ...doc.audio]) {
      const el = overlayMedia.current.get(item.id);
      if (!el) continue;
      el.volume = Math.max(0, Math.min(1, item.volume / 100));
      const local = clampT - item.at;
      const want = el.duration > 0 ? Math.min(local, el.duration) : local;
      if (Math.abs(el.currentTime - want) > 0.15) el.currentTime = Math.max(0, want);
      if (playing && !el.ended) {
        if (el.paused) void el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }
  }, [clampT, playing, doc.broll, doc.audio]);

  /* ---- what is on screen right now ---- */

  const loc = total > 0 ? locate(edl, clampT) : null;

  // Captions come from OUTPUT-time words: per-asset word edits applied first,
  // then the words remapped through the EDL so they stay correct across cuts
  // and clip hops, then chunked with the doc's layout and break overrides.
  const wordsByAsset = useMemo(() => {
    const m: Record<string, Word[]> = {};
    for (const a of assets) {
      if (a.words && a.words.length > 0) m[a.id] = editedWords(a.words, doc.wordEdits[a.id] ?? {});
    }
    return m;
  }, [assets, doc.wordEdits]);
  const outWords = useMemo(() => outputWords(edl, wordsByAsset), [edl, wordsByAsset]);
  const chunks = useMemo(() => {
    if (!doc.captions.enabled) return [];
    const list = chunksFor(outWords, doc.captions.style.wordsPerLine, doc.captions.style.lines);
    for (const b of doc.captions.breaks) {
      const c = list[b.chunkIndex];
      if (c) list[b.chunkIndex] = { ...c, text: b.text };
    }
    return list;
  }, [
    doc.captions.enabled,
    doc.captions.style.wordsPerLine,
    doc.captions.style.lines,
    doc.captions.breaks,
    outWords,
  ]);

  const chunkIndex = chunks.findIndex((c) => c.start <= clampT && clampT < c.end);
  // An override with empty text removes that caption; the chunk stays in the
  // list so later break indices keep pointing at the right chunks.
  const caption =
    chunkIndex >= 0 && chunks[chunkIndex].text.trim() ? chunks[chunkIndex] : undefined;

  // Karaoke accent: an explicit karaoke animation wins; with no animation
  // chosen the template decides via its accent color. Any other animation
  // turns the highlight off, and a break-overridden chunk never highlights.
  const anim = doc.captions.style.animation;
  const wantsKaraoke =
    anim === "karaoke" ||
    (anim === undefined &&
      Boolean(CAPTION_TEMPLATES.find((t) => t.id === doc.captions.template)?.style.accentColor));
  const karaoke =
    wantsKaraoke &&
    Boolean(doc.captions.style.accentColor) &&
    !doc.captions.breaks.some((b) => b.chunkIndex === chunkIndex);
  const perChunk = doc.captions.style.wordsPerLine * doc.captions.style.lines;
  const captionWords =
    caption && karaoke ? outWords.slice(chunkIndex * perChunk, chunkIndex * perChunk + perChunk) : null;

  const visibleTexts = doc.texts.filter((t) => clampT >= t.at && clampT < t.at + t.dur);

  /** Scale from active zoom items at this output time; the last one wins. */
  const zoomAt = (t: number): number => {
    let scale = 1;
    for (const z of doc.zooms) {
      let i = -1;
      for (let k = edl.length - 1; k >= 0; k--) {
        if (z.at >= (segStarts[k] ?? 0)) {
          i = k;
          break;
        }
      }
      if (i < 0) continue;
      const seg = edl[i]!;
      const segEnd = (segStarts[i] ?? 0) + (seg.srcOut - seg.srcIn);
      if (z.kind === "quickzoom") {
        const q = ZOOM.quickzoom;
        const target = q.scale[z.size];
        const dt = t - z.at;
        if (dt >= 0 && dt <= q.inSec + q.holdSec + q.outSec) {
          if (dt < q.inSec) scale = 1 + (target - 1) * (dt / q.inSec);
          else if (dt < q.inSec + q.holdSec) scale = target;
          else scale = target - (target - 1) * ((dt - q.inSec - q.holdSec) / q.outSec);
        }
      } else if (t >= z.at && t < segEnd) {
        const target = ZOOM[z.kind].scale[z.size];
        scale =
          z.kind === "punchin"
            ? target
            : 1 + (target - 1) * ((t - z.at) / Math.max(0.001, segEnd - z.at));
      }
    }
    return scale;
  };

  const fx = loc ? doc.clipFx[loc.assetId] : undefined;
  const wrapStyle: CSSProperties = {
    transform: `translate(${fx?.x ?? 0}%, ${fx?.y ?? 0}%) rotate(${fx?.rotate ?? 0}deg) scale(${
      (fx?.zoom ?? 1) * zoomAt(clampT)
    })`,
    filter: colorFilter(doc.color, fx?.color),
  };

  /* ---- scrubber ---- */

  const troughRef = useRef<HTMLDivElement | null>(null);
  const scrubAt = (e: ReactPointerEvent) => {
    const el = troughRef.current;
    if (!el || total <= 0) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seek(frac * total);
  };
  const pct = total > 0 ? (clampT / total) * 100 : 0;

  return (
    <div className="pv">
      <div className="pv-frame glass-sm">
        <div className="pv-screen">
          <div className="pv-videowrap" style={wrapStyle}>
            <video ref={videoRef} playsInline onLoadedMetadata={onLoadedMetadata} />
          </div>
          <div className="pv-media">
            {doc.broll
              .filter((b) => clampT >= b.at && clampT < b.at + b.dur)
              .map((b) => {
                const dt = clampT - b.at;
                let op = 1;
                if (b.fadeIn > 0) op = Math.min(op, dt / b.fadeIn);
                if (b.fadeOut > 0) op = Math.min(op, (b.dur - dt) / b.fadeOut);
                return (
                  <video
                    key={b.id}
                    ref={regMedia(b.id)}
                    className={`pv-broll pv-shape-${b.shape}`}
                    src={srcOf(b.assetId)}
                    muted={b.volume <= 0}
                    playsInline
                    preload="auto"
                    style={{
                      left: `calc(50% + ${b.x}%)`,
                      top: `calc(50% + ${b.y}%)`,
                      width: `${b.scale * 100}%`,
                      opacity: Math.max(0, Math.min(1, op)),
                    }}
                  />
                );
              })}
            {doc.graphics
              .filter((g) => clampT >= g.at && clampT < g.at + g.dur)
              .map((g) => {
                const src = fileUrl(byId[g.assetId]?.sourceUrl ?? null);
                if (!src) return null;
                return (
                  <img
                    key={g.id}
                    className="pv-graphic"
                    src={src}
                    alt=""
                    style={{
                      left: `calc(50% + ${g.x}%)`,
                      top: `calc(50% + ${g.y}%)`,
                      width: `${g.scale * 100}%`,
                      transform: `translate(-50%,-50%) rotate(${g.rotate}deg)`,
                      opacity: Math.max(0, Math.min(1, g.opacity / 100)),
                    }}
                  />
                );
              })}
            {doc.audio
              .filter((a) => clampT >= a.at && clampT < a.at + a.dur)
              .map((a) => (
                <audio key={a.id} ref={regMedia(a.id)} src={srcOf(a.assetId)} preload="auto" />
              ))}
          </div>
          <div className="pv-overlays">
            {visibleTexts.map((t) => (
              <div key={t.id} className="pv-text" style={overlayCss(t.x, t.y, t.style)}>
                {t.content}
              </div>
            ))}
            {caption && (
              <div
                className="pv-text pv-caption"
                style={overlayCss(doc.captions.style.x, doc.captions.style.y, doc.captions.style)}
              >
                {captionWords
                  ? captionWords.map((w, i) => (
                      <span
                        key={i}
                        style={
                          w.start <= clampT && clampT < w.end
                            ? { color: doc.captions.style.accentColor }
                            : undefined
                        }
                      >
                        {(i === 0 ? "" : i % doc.captions.style.wordsPerLine === 0 ? "\n" : " ") +
                          w.word}
                      </span>
                    ))
                  : caption.text}
              </div>
            )}
          </div>
          {safe && (
            <div className="pv-safe">
              <div className="pv-safe-top">
                <span>keep clear</span>
              </div>
              <div className="pv-safe-bottom">
                <span>keep clear</span>
              </div>
              <div className="pv-safe-right">
                <span>keep clear</span>
              </div>
            </div>
          )}
          <div className="pv-notch" />
          <div className="pv-home" />
        </div>

        <div className="pv-transport">
          <button className="iconbtn" title="Back to start" onClick={() => seek(0)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5v14" />
              <path d="M19 5l-10 7 10 7V5z" />
            </svg>
          </button>
          <button className="iconbtn" title="Undo" onClick={undo} disabled={!canUndo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 14L4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 6 6v1" />
            </svg>
          </button>
          <button
            className="iconbtn pv-play"
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
          <button className="iconbtn" title="Redo" onClick={redo} disabled={!canRedo}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 14l5-5-5-5" />
              <path d="M20 9H10a6 6 0 0 0-6 6v1" />
            </svg>
          </button>
          <button
            className={`iconbtn${safe ? " pv-eye-on" : ""}`}
            title="Show social safe zones"
            onClick={() => setSafe((s) => !s)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
          </button>
        </div>

        <div
          className="pv-scrub"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubAt(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrubAt(e);
          }}
        >
          <div className="pv-scrub-trough" ref={troughRef}>
            <div className="pv-scrub-fill" style={{ width: `${pct}%` }} />
            <div
              className="pv-scrub-dot"
              style={{ left: `${pct}%`, transform: "translate(-50%,-50%)" }}
            />
          </div>
        </div>

        <div className="pv-time mini">
          {fmt(clampT)} / {fmt(total)}
        </div>
      </div>
    </div>
  );
}
