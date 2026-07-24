"""Toreroflow captions microservice — faster-whisper transcription lands in M2.

M0 scaffolds the FastAPI app so the workspace shape matches spec Section 6.
Run: pip install -r requirements.txt && uvicorn main:app --port 4710
"""

from fastapi import FastAPI

app = FastAPI(title="toreroflow-captions")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "toreroflow-captions"}
