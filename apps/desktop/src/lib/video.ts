export interface VideoProbe {
  /** Object URL of the source file — usable as a <video src> for preview. */
  url: string;
  /** JPEG data URL captured from the video itself (no generation involved). */
  thumbnail: string;
  durationSec: number;
  width: number;
  height: number;
}

/**
 * Extract a real thumbnail frame + metadata from a dropped video file,
 * entirely client-side via <video> + <canvas>.
 */
export function probeVideo(file: File): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.src = url;

    const fail = (message: string) => {
      URL.revokeObjectURL(url);
      reject(new Error(message));
    };

    video.onerror = () => fail(`Could not read video: ${file.name}`);

    video.onloadedmetadata = () => {
      // Grab a frame ~1s in (or a quarter through for very short clips).
      const target = Math.min(1, video.duration * 0.25);
      video.currentTime = Number.isFinite(target) ? target : 0;
    };

    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 640 / video.videoHeight);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return fail("canvas unavailable");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve({
        url,
        thumbnail: canvas.toDataURL("image/jpeg", 0.72),
        durationSec: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
  });
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
