import io
import logging
import os
import secrets
import threading
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from myanmar_tts import MyanmarTTS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("myanmar-tts")

MODEL_ID = "freococo/MyanmarTTS"
MAX_TEXT_CHARACTERS = 3500
MODEL = None
MODEL_LOCK = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global MODEL
    torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))
    logger.info("Loading %s on CPU", MODEL_ID)
    try:
        MODEL = MyanmarTTS(device="cpu")
        logger.info("MyanmarTTS model is ready")
    except Exception:
        logger.exception("Could not load MyanmarTTS model")
        MODEL = None
    yield
    MODEL = None


app = FastAPI(title="Movie Recap Studio Myanmar TTS", lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARACTERS)
    steps: int = Field(default=8, ge=8, le=24)


@app.get("/health")
def health():
    return {
        "status": "ok" if MODEL is not None else "starting",
        "model_loaded": MODEL is not None,
        "model": MODEL_ID,
        "device": "cpu",
    }


@app.post("/tts")
def synthesize(
    payload: TTSRequest,
    authorization: str | None = Header(default=None),
):
    expected = os.getenv("MYANMAR_TTS_SERVICE_TOKEN", "")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not expected or not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")

    if MODEL is None:
        raise HTTPException(status_code=503, detail="MyanmarTTS model is still loading. Try again shortly.")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    if len(text) > MAX_TEXT_CHARACTERS:
        raise HTTPException(status_code=413, detail=f"Text exceeds {MAX_TEXT_CHARACTERS} characters.")

    try:
        # Serialize inference to keep memory usage predictable on free CPU hardware.
        with MODEL_LOCK, torch.inference_mode():
            audio = MODEL.tts(text, solver="euler", step=payload.steps, cfg=3.0)

        samples = np.asarray(audio, dtype=np.float32).squeeze()
        if samples.size == 0:
            raise RuntimeError("The TTS model returned empty audio.")

        output = io.BytesIO()
        sf.write(output, samples, 44100, format="WAV", subtype="PCM_16")
        return Response(
            content=output.getvalue(),
            media_type="audio/wav",
            headers={"Cache-Control": "no-store", "X-TTS-Model": MODEL_ID},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("MyanmarTTS inference failed")
        raise HTTPException(status_code=500, detail="MyanmarTTS inference failed. Check Space logs.") from exc
