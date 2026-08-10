"""Toreroflow captions microservice: local transcription via faster-whisper.

Run: .venv\\Scripts\\python.exe -m uvicorn main:app --port 4710
The model (base, int8, CPU) downloads on first use and is cached by HF.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="toreroflow-captions")
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


class TranscribeRequest(BaseModel):
    path: str


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
    try:
        segments, info = get_model().transcribe(
            req.path, vad_filter=True, word_timestamps=True
        )
        out = [
            {
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip()}
                    for w in (s.words or [])
                ],
            }
            for s in segments
        ]
    except Exception as exc:  # surface as a clean 500 for the worker
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"language": info.language, "durationSec": info.duration, "segments": out}
