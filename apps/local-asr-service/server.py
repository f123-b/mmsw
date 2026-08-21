"""WebSocket facade for the OpenASR Fun-ASR-Nano local service.

Protocol:
  client -> JSON {type:"config", model, language, sampleRate, channels, vad}
  client -> binary PCM16, 16 kHz, mono
  server -> {type:"asr_partial", text, startMs, endMs, confidence}
  server -> {type:"asr_final", text, startMs, endMs, confidence}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass, field

import websockets

from asr_engine import FunASREngine
from vad import EnergyVAD

LOGGER = logging.getLogger("local-asr-service")


@dataclass
class Session:
    engine: FunASREngine
    sample_rate: int = 16_000
    use_vad: bool = True
    vad: EnergyVAD = field(default_factory=EnergyVAD)
    speech_pcm: bytearray = field(default_factory=bytearray)
    start_ms: int | None = None
    end_ms: int = 0
    last_partial_ms: int = 0

    async def configure(self, message: dict) -> None:
        self.sample_rate = int(message.get("sampleRate", 16_000))
        if self.sample_rate != 16_000:
            raise ValueError("Local Fun-ASR service accepts 16 kHz PCM16 only")
        self.use_vad = bool(message.get("vad", True))
        self.engine.model = str(message.get("model") or self.engine.model)
        self.engine.language = str(message.get("language") or self.engine.language)
        self.vad = EnergyVAD(sample_rate=self.sample_rate)

    async def push(self, pcm: bytes, send) -> None:
        result = self.vad.process(pcm) if self.use_vad else None
        if self.use_vad and result and not result.speech and not result.speech_ended and not result.speech_started:
            return
        if self.start_ms is None and result:
            self.start_ms = result.start_time
        self.speech_pcm.extend(pcm)
        self.end_ms = result.end_time if result else self.end_ms + round(len(pcm) * 1000 / 2 / self.sample_rate)
        if result and result.speech and self.end_ms - self.last_partial_ms >= 400:
            self.last_partial_ms = self.end_ms
            await self.emit(send, "asr_partial")
        if result and result.speech_ended:
            await self.emit(send, "asr_final")

    async def emit(self, send, event_type: str) -> None:
        if not self.speech_pcm:
            return
        try:
            text, confidence = await self.engine.transcribe(bytes(self.speech_pcm), self.sample_rate)
        except Exception as exc:  # noqa: BLE001 - surface backend errors over the protocol
            await send(json.dumps({"type": "error", "message": f"Fun-ASR backend failed: {exc}"}))
            return
        if text:
            await send(json.dumps({
                "type": event_type,
                "text": text,
                "startMs": self.start_ms or 0,
                "endMs": max(self.start_ms or 0, self.end_ms),
                "confidence": confidence,
            }))
        if event_type == "asr_final":
            self.speech_pcm.clear()
            self.start_ms = None
            self.end_ms = 0
            self.last_partial_ms = 0
            self.vad.reset()


async def handle(websocket, engine: FunASREngine) -> None:
    session = Session(engine=engine)
    await websocket.send(json.dumps({"type": "ready", "model": engine.model, "sampleRate": 16_000}))
    configured = False
    try:
        async for payload in websocket:
            if isinstance(payload, str):
                message = json.loads(payload)
                if message.get("type") == "config":
                    await session.configure(message)
                    configured = True
                    await websocket.send(json.dumps({"type": "ready", "model": session.engine.model, "sampleRate": session.sample_rate}))
                continue
            if not configured:
                await websocket.send(json.dumps({"type": "error", "message": "Send config before PCM audio"}))
                continue
            await session.push(bytes(payload), websocket.send)
    except websockets.ConnectionClosed:
        return


async def main(args: argparse.Namespace) -> None:
    engine = FunASREngine(model=args.model, upstream=args.upstream)
    if not await engine.health():
        LOGGER.warning("OpenASR backend is not reachable at %s; start `openasr serve` before sending audio", args.upstream)
    async with websockets.serve(lambda websocket: handle(websocket, engine), args.host, args.port, ping_interval=20):
        LOGGER.info("Local Fun-ASR service listening on ws://%s:%s (model=%s)", args.host, args.port, args.model)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="funasr-nano:q8")
    parser.add_argument("--upstream", default="http://127.0.0.1:8080")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(parser.parse_args()))
