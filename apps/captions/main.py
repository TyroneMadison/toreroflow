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
