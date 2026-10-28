"""Toreroflow captions microservice: local transcription via faster-whisper.

Run: .venv\\Scripts\\python.exe -m uvicorn main:app --port 4710
The model downloads on first use and is cached by HF. WHISPER_MODEL picks it
(default "small", the master prompt's accuracy floor for word-level cuts;
"base" is still available), WHISPER_DEVICE / WHISPER_COMPUTE pick where it
runs (default cpu / int8).

/faces samples face boxes for the auto reframe engine (packages/core
reframe.ts) with OpenCV YuNet. FACE_FPS sets the sample rate (default 5),
YUNET_MODEL the onnx path (the Dockerfile bakes it in).
"""

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="toreroflow-captions")
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(
            os.environ.get("WHISPER_MODEL", "small"),
            device=os.environ.get("WHISPER_DEVICE", "cpu"),
            compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
        )
    return _model


class TranscribeRequest(BaseModel):
    path: str
    # ISO code ("en", "es"); None lets whisper detect it.
    language: str | None = None
    # Optional window, in seconds. The worker windows long sources itself so
    # one request never outlives its timeout; times come back absolute.
    start: float | None = None
    dur: float | None = None


def _window_audio(path: str, start: float, dur: float):
    """Decode just [start, start+dur) to 16 kHz mono float32 via ffmpeg."""
    import subprocess

    import numpy as np

    raw = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error",
            "-ss", str(start), "-t", str(dur), "-i", path,
            "-ac", "1", "-ar", "16000", "-f", "f32le", "-",
        ],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "toreroflow-captions"}


class SeparateRequest(BaseModel):
    path: str
    # "voice" keeps the speech; "instrumental" keeps everything else.
    mode: str
    out_dir: str


@app.post("/separate")
def separate(req: SeparateRequest) -> dict:
    """Split a file's audio into voice and everything-else with Demucs.

    Runs the CLI in two-stems mode rather than importing the API: the model
    load lives in a child process, so a separation cannot bloat this
    process's memory for the transcriptions that follow it. CPU-bound and
    slow (roughly realtime), which is why the worker queues it.
    """
    import subprocess
    import sys
    from pathlib import Path

    if req.mode not in ("voice", "instrumental"):
        raise HTTPException(status_code=400, detail="mode is voice or instrumental")
    src = Path(req.path)
    if not src.is_file():
        raise HTTPException(status_code=400, detail=f"no file at {req.path}")
    out_root = Path(req.out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                sys.executable, "-m", "demucs",
                "--two-stems=vocals", "-n", "htdemucs",
                "--mp3", "-o", str(out_root),
                str(src),
            ],
            check=True, capture_output=True, text=True, timeout=1800,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=exc.stderr[-2000:]) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="demucs is not installed in this environment (pip install demucs)",
        ) from exc
    stem = "vocals" if req.mode == "voice" else "no_vocals"
    produced = out_root / "htdemucs" / src.stem / f"{stem}.mp3"
    if not produced.is_file():
        raise HTTPException(status_code=500, detail=f"demucs produced no {stem} stem")
    return {"path": str(produced)}


@app.post("/transcribe")
def transcribe(req: TranscribeRequest) -> dict:
    offset = 0.0
    try:
        audio = req.path
        if req.start is not None and req.dur is not None:
            offset = max(0.0, req.start)
            audio = _window_audio(req.path, offset, req.dur)
        segments, info = get_model().transcribe(
            audio, vad_filter=True, word_timestamps=True, language=req.language
        )
        out = [
            {
                "start": round(s.start + offset, 3),
                "end": round(s.end + offset, 3),
                "text": s.text.strip(),
                "words": [
                    {
                        "start": round(w.start + offset, 3),
                        "end": round(w.end + offset, 3),
                        "word": w.word.strip(),
                    }
                    for w in (s.words or [])
                ],
            }
            for s in segments
        ]
    except Exception as exc:  # surface as a clean 500 for the worker
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"language": info.language, "durationSec": info.duration, "segments": out}


class FacesRequest(BaseModel):
    path: str
    out: str
    fps: float | None = None


_yunet = None


def _detector(w: int, h: int):
    global _yunet
    import cv2

    if _yunet is None:
        model = os.environ.get("YUNET_MODEL", "/opt/yunet/face_detection_yunet_2023mar.onnx")
        if not os.path.isfile(model):
            raise HTTPException(status_code=500, detail=f"face model missing at {model} (set YUNET_MODEL)")
        _yunet = cv2.FaceDetectorYN.create(model, "", (w, h), 0.6, 0.3, 20)
    _yunet.setInputSize((w, h))
    return _yunet


@app.post("/faces")
def faces(req: FacesRequest) -> dict:
    """Face boxes per sampled frame, plus a mouth-motion value per face.

    The master prompt asks for MediaPipe Face Mesh lip distance; MediaPipe's
    legacy solutions API is gone from the wheels that install on
    python:3.11-slim today, so this is the allowed YuNet fallback. YuNet gives
    a box and five landmarks but no lips, so `mouth` is the mean absolute
    change of the grey mouth patch (between the mouth corners, down to the
    chin) since the previous sample, divided by 255. A talker's patch churns,
    a listener's or a poster's barely moves: what reframe.ts z-scores into
    activeness. Boxes are fractions of the frame, x/y the top-left corner.
    """
    import json
    import subprocess
    from pathlib import Path

    import cv2
    import numpy as np

    fps = req.fps or float(os.environ.get("FACE_FPS", "5"))
    src = Path(req.path)
    if not src.is_file():
        raise HTTPException(status_code=400, detail=f"no file at {req.path}")
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail=f"could not open {req.path}")
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    # Decode at the sample rate and a 640-wide working size via ffmpeg: one
    # pass, no seeking, and detection cost no longer scales with 4K sources.
    sw = min(640, W - W % 2)
    sh = int(round(H * sw / W / 2)) * 2
    proc = subprocess.Popen(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(src),
            "-vf", f"fps={fps},scale={sw}:{sh}", "-pix_fmt", "bgr24", "-f", "rawvideo", "-",
        ],
        stdout=subprocess.PIPE,
    )
    det = _detector(sw, sh)
    frames = []
    prev = None
    size = sw * sh * 3
    i = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            img = np.frombuffer(buf, dtype=np.uint8).reshape(sh, sw, 3)
            grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
            _, found = det.detect(img)
            out = []
            for f in found if found is not None else []:
                x, y, w, h = (float(v) for v in f[:4])
                # Landmarks 3 and 4 are the mouth corners.
                mx0, mx1 = sorted((f[10], f[12]))
                my = max(f[11], f[13])
                x0 = int(max(0, mx0 - w * 0.05))
                x1 = int(min(sw, mx1 + w * 0.05))
                y0 = int(max(0, my - h * 0.12))
                y1 = int(min(sh, y + h))
                mouth = 0.0
                if prev is not None and x1 > x0 + 1 and y1 > y0 + 1:
                    mouth = float(np.mean(np.abs(grey[y0:y1, x0:x1] - prev[y0:y1, x0:x1])) / 255)
                out.append({
                    "x": round(x / sw, 4), "y": round(y / sh, 4),
                    "w": round(w / sw, 4), "h": round(h / sh, 4),
                    "score": round(float(f[14]), 3), "mouth": round(mouth, 4),
                })
            frames.append({"t": round(i / fps, 3), "faces": out})
            prev = grey
            i += 1
    finally:
        proc.stdout.close()
        proc.wait()
    Path(req.out).parent.mkdir(parents=True, exist_ok=True)
    Path(req.out).write_text(json.dumps({"fps": fps, "w": W, "h": H, "frames": frames}))
    return {"out": req.out, "frames": len(frames)}
