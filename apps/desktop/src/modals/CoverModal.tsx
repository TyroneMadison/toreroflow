import { useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { useToast } from "../components/Toasts";
import { api, fileUrl, uploadCoverImage, videoLabel, type MediaAssetInfo } from "../lib/api";
import { createSeekQueue } from "../lib/seekQueue";

/** One frame at 30fps, the rate nearly all social video is delivered at. */
const FRAME_SEC = 1 / 30;

/** m:ss.cc, so a chosen frame can actually be told apart from its neighbour. */
function fmtPosition(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

interface CoverModalProps {
  asset: MediaAssetInfo;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Pick the frame that fronts this video everywhere a platform allows a
 * custom cover (Instagram, TikTok, YouTube long-form), or upload an image
 * instead. The app's own thumbnails switch to the choice, so the card
 * always shows exactly what will post.
 */
export default function CoverModal({ asset, onClose, onChanged }: CoverModalProps) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [positionSec, setPositionSec] = useState(() => {
    const fallback = Math.min(1, Math.max(asset.durationSec ?? 1, 0.1));
    return asset.coverOffsetMs != null ? asset.coverOffsetMs / 1000 : fallback;
  });
  const [busy, setBusy] = useState<"frame" | "upload" | "clear" | null>(null);
  const src = fileUrl(asset.videoUrl);
  const duration = asset.durationSec ?? 0;

  /*
   * One seek in flight, always aimed at the newest position.
   *
   * The slider still updates on every event, so the handle tracks the pointer
   * exactly; only the decoder is spared. Assigning currentTime on every change
   * is what made this stutter, because each assignment threw away a seek the
   * browser had already started.
   */
  const seeks = useMemo(() => createSeekQueue(() => video.current), []);

  const seek = (sec: number) => {
    setPositionSec(sec);
    seeks.request(sec);
  };

  const useFrame = async () => {
    setBusy("frame");
    try {
      await api.patch(`/media/${asset.id}/cover`, { offsetMs: Math.round(positionSec * 1000) });
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not set the cover", err);
    } finally {
      setBusy(null);
    }
  };

  const uploadImage = async (file: File) => {
    setBusy("upload");
    try {
      await uploadCoverImage(asset.id, file);
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not upload the cover", err);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    try {
      await api.del(`/media/${asset.id}/cover`);
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not remove the cover", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal maxWidth={560} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Edit cover</h3>
          <p>{videoLabel(asset)}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <div className="coverstage">
          {src ? (
            <video
              ref={video}
              src={src}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={() => {
                // Paint the frame the slider claims, not frame zero.
                if (video.current) video.current.currentTime = positionSec;
              }}
              onSeeked={() => seeks.settled()}
            />
          ) : (
            <div className="coverwait">Video not ready yet.</div>
          )}
        </div>
        <label className="flabel" style={{ marginTop: 14 }}>
          Scrub to the frame you want
          <span className="hint">
            {fmtPosition(positionSec)}
            {duration > 0 ? ` of ${fmtPosition(duration)}` : ""} · arrow keys step one frame
          </span>
        </label>
        <input
          className="coverscrub"
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          /*
           * A frame at 30fps rather than 50ms. The old step was coarser than a
           * frame, so arrow keys skipped one or two and "frame by frame" was
           * not actually available. Most social video is 30fps; the container
           * does not tell us the rate, and being slightly fine is harmless
           * where being coarse loses frames outright.
           */
          step={FRAME_SEC}
          value={positionSec}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
          Used on Instagram, TikTok, and YouTube long form. YouTube Shorts pick
          their own thumbnail, that is YouTube's rule, not ours.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadImage(f);
            e.target.value = "";
          }}
        />
      </div>
      <div className="modal-foot">
        <button className="btn ghost" disabled={busy !== null} onClick={() => void clear()}>
          {busy === "clear" ? "Removing…" : "Use auto thumbnail"}
        </button>
        <button
          className="btn ghost"
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {busy === "upload" ? "Uploading…" : "Upload an image"}
        </button>
        <button className="btn" disabled={busy !== null || !src} onClick={() => void useFrame()}>
          {busy === "frame" ? "Saving…" : "Use this frame"}
        </button>
      </div>
    </Modal>
  );
}
