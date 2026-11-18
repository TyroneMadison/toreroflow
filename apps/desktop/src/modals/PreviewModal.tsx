import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import { useIsPhone } from "../lib/phone";
import { mmss } from "../components/mobile/ThumbPlayer";

interface PreviewModalProps {
  name: string;
  url: string;
  onClose: () => void;
}

/** Plays the actual dropped video file from its object URL. */
export default function PreviewModal({ name, url, onClose }: PreviewModalProps) {
  const isPhone = useIsPhone();
  if (isPhone) return <PhonePreview name={name} url={url} onClose={onClose} />;
  return (
    <Modal maxWidth={720} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Preview</h3>
          <p>{name}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <video className="previewvid" src={url} controls autoPlay />
      </div>
    </Modal>
  );
}

/**
 * The phone preview (mobile pass): the whole screen in the video's shape,
 * playing with sound since a tap opened it. Close top left or swipe down;
 * one big play and pause button; tap the video to show or hide the controls
 * (they fade three seconds into playback); a scrubber with a 44px touch
 * area and the time; double-tap either half to jump five seconds; mute top
 * right.
 */
function PhonePreview({ name, url, onClose }: PreviewModalProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(true);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const lastTap = useRef(0);
  const swipe = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (!playing || !shown) return;
    const t = window.setTimeout(() => setShown(false), 3000);
    return () => window.clearTimeout(t);
  }, [playing, shown]);
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const jump = (by: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + by));
  };
  return (
    <div
      className={`mb-preview${shown || !playing ? " shown" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview, ${name}`}
      onPointerDown={(e) => (swipe.current = e.clientY)}
      onPointerUp={(e) => {
        if (swipe.current != null && e.clientY - swipe.current > 120) onClose();
        swipe.current = null;
      }}
    >
      <video
        ref={video}
        src={url}
        autoPlay
        playsInline
        muted={muted}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onClick={(e) => {
          const now = Date.now();
          if (now - lastTap.current < 300) {
            const r = e.currentTarget.getBoundingClientRect();
            jump(e.clientX < r.left + r.width / 2 ? -5 : 5);
          } else setShown((s) => !s);
          lastTap.current = now;
        }}
      />
      <div className="mb-pvtop">
        <button type="button" className="mb-ib ghost" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href="#i-x" />
          </svg>
        </button>
        <span className="mb-pvttl">
          <b>Preview</b>
          <small>{name}</small>
        </span>
        <button type="button" className="mb-ib ghost" aria-label={muted ? "Sound on" : "Mute"} aria-pressed={muted} onClick={() => setMuted((m) => !m)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <use href={muted ? "#i-x" : "#i-music"} />
          </svg>
        </button>
      </div>
      <button type="button" className="mb-pvplay" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <use href={playing ? "#i-pause" : "#i-play"} />
        </svg>
      </button>
      <div className="mb-pvbar">
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.01}
          value={Math.min(time, dur || 0)}
          aria-label="Seek"
          style={{ ["--p" as string]: `${dur ? (time / dur) * 100 : 0}%` }}
          onChange={(e) => {
            if (video.current) video.current.currentTime = Number(e.target.value);
          }}
        />
        <span>
          {mmss(time)} / {mmss(dur)}
        </span>
      </div>
    </div>
  );
}
