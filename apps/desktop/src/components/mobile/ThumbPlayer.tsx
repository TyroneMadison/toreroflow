import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

/** 0:03, 1:05:20. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export interface ThumbPlayerHandle {
  seek(sec: number): void;
}

/**
 * The phone's thumb-sized player (mobile pass): tap the video to play or
 * pause, a big play button, a thick scrubber with note markers, the time, and
 * 44px sound and full-screen buttons. Controls fade three seconds into
 * playback and come back on a tap.
 */
const ThumbPlayer = forwardRef<
  ThumbPlayerHandle,
  {
    src: string | null;
    label: string;
    markers?: Array<{ at: number; done?: boolean }>;
    onTime?(sec: number): void;
    onDuration?(sec: number): void;
    durationHint?: number | null;
  }
>(function ThumbPlayer({ src, label, markers = [], onTime, onDuration, durationHint }, ref) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(durationHint ?? 0);
  const [muted, setMuted] = useState(false);
  const [shown, setShown] = useState(true);
  const seek = (sec: number) => {
    if (video.current) video.current.currentTime = sec;
    setTime(sec);
    onTime?.(sec);
  };
  useImperativeHandle(ref, () => ({ seek }));
  useEffect(() => {
    if (!playing || !shown) return;
    const t = window.setTimeout(() => setShown(false), 3000);
    return () => window.clearTimeout(t);
  }, [playing, shown]);
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  const fullscreen = () => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (box.current?.requestFullscreen) void box.current.requestFullscreen().catch(() => el?.webkitEnterFullscreen?.());
    else el?.webkitEnterFullscreen?.();
  };
  const pct = dur > 0 ? Math.min(100, (time / dur) * 100) : 0;
  return (
    <div ref={box} className={`mb-player${shown || !playing ? " shown" : ""}`}>
      <video
        ref={video}
        src={src ?? undefined}
        playsInline
        preload="metadata"
        muted={muted}
        aria-label={label}
        onClick={() => {
          setShown(true);
          toggle();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          onTime?.(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration || durationHint || 0;
          setDur(d);
          onDuration?.(d);
        }}
      />
      {!playing && (
        <button type="button" className="mb-big" aria-label="Play" onClick={toggle}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href="#i-play" />
          </svg>
        </button>
      )}
      <div className="mb-ctl">
        <div className="mb-scrub">
          <input
            type="range"
            min={0}
            max={dur || 0}
            step={0.01}
            value={Math.min(time, dur || 0)}
            aria-label="Seek"
            style={{ ["--p" as string]: `${pct}%` }}
            onChange={(e) => seek(Number(e.target.value))}
            onPointerDown={() => setShown(true)}
          />
          {dur > 0 &&
            markers.map((m, i) => (
              <button
                key={`${m.at}-${i}`}
                type="button"
                className={`mb-pmk${m.done ? " done" : ""}`}
                style={{ left: `${Math.min(100, (m.at / dur) * 100)}%` }}
                aria-label={`Jump to ${mmss(m.at)}`}
                onClick={() => seek(m.at)}
              />
            ))}
        </div>
        <div className="mb-ctlrow">
          <span>
            {mmss(time)} / {mmss(dur)}
          </span>
          <span className="mb-ctlbtns">
            <button type="button" className="mb-ib ghost" aria-label={muted ? "Sound on" : "Mute"} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href={muted ? "#i-x" : "#i-music"} />
              </svg>
            </button>
            <button type="button" className="mb-ib ghost" aria-label="Full screen" onClick={fullscreen}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-expand" />
              </svg>
            </button>
          </span>
        </div>
      </div>
    </div>
  );
});

export default ThumbPlayer;
