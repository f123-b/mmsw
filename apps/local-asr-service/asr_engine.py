"""Fun-ASR-Nano engine boundary.

OpenASR ships Fun-ASR-Nano as a native .oasr pack and exposes an OpenAI-
compatible local HTTP API. Keeping this adapter HTTP-based avoids embedding a
large model or native runtime in Electron and makes the backend replaceable.
"""

from __future__ import annotations

import json
import wave
from io import BytesIO
from typing import Any

import httpx


def pcm16_wav(pcm: bytes, sample_rate: int = 16_000) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


class FunASREngine:
    def __init__(self, model: str = "funasr-nano:q8", language: str = "zh-CN",
                 upstream: str = "http://127.0.0.1:8080", timeout: float = 30.0) -> None:
        self.model = model
        self.language = language
        self.upstream = upstream.rstrip("/")
        self.timeout = timeout

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.upstream}/health")
                return response.is_success
        except httpx.HTTPError:
            return False

    async def transcribe(self, pcm: bytes, sample_rate: int = 16_000) -> tuple[str, float]:
        if not pcm:
            return "", 0.0
        form = {"model": self.model, "response_format": "json"}
        files = {"file": ("audio.wav", pcm16_wav(pcm, sample_rate), "audio/wav")}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{self.upstream}/v1/audio/transcriptions", data=form, files=files)
            response.raise_for_status()
            payload: Any
            try:
                payload = response.json()
            except json.JSONDecodeError:
                payload = {"text": response.text}
        if isinstance(payload, dict):
            text = payload.get("text") or payload.get("transcript") or ""
            confidence = payload.get("confidence", 0.95)
        else:
            text = str(payload)
            confidence = 0.95
        return str(text).strip(), float(confidence)

