"""Small PCM16 VAD used at the service boundary.

The OpenASR native runtime remains responsible for Fun-ASR-Nano inference. This
module keeps silence out of the inference queue and is intentionally dependency
free so the service can start before an optional native VAD binding is added.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass


@dataclass(frozen=True)
class VADResult:
    speech: bool
    start_time: int
    end_time: int
    speech_started: bool = False
    speech_ended: bool = False


class EnergyVAD:
    def __init__(self, sample_rate: int = 16_000, threshold: float = 0.012,
                 min_speech_ms: int = 80, end_silence_ms: int = 320) -> None:
        self.sample_rate = sample_rate
        self.threshold = threshold
        self.min_speech_samples = max(1, round(min_speech_ms * sample_rate / 1000))
        self.end_silence_samples = max(1, round(end_silence_ms * sample_rate / 1000))
        self.sample_cursor = 0
        self.speech_start: int | None = None
        self.last_speech_sample = 0

    def process(self, pcm: bytes) -> VADResult:
        if len(pcm) % 2:
            raise ValueError("VAD expects little-endian PCM16")
        count = len(pcm) // 2
        samples = struct.unpack(f"<{count}h", pcm) if count else ()
        rms = math.sqrt(sum((sample / 32768.0) ** 2 for sample in samples) / count) if count else 0.0
        frame_start = self.sample_cursor
        frame_end = frame_start + count
        self.sample_cursor = frame_end
        loud = rms >= self.threshold
        started = False
        ended = False
        if loud:
            if self.speech_start is None:
                self.speech_start = frame_start
                started = True
            self.last_speech_sample = frame_end
        elif self.speech_start is not None and frame_end - self.last_speech_sample >= self.end_silence_samples:
            self.speech_start = None
            ended = True
        active = self.speech_start is not None and self.last_speech_sample - self.speech_start >= self.min_speech_samples
        start = self.speech_start if self.speech_start is not None else frame_start
        end = self.last_speech_sample if active else frame_end
        return VADResult(
            speech=active,
            start_time=round(start * 1000 / self.sample_rate),
            end_time=round(end * 1000 / self.sample_rate),
            speech_started=started,
            speech_ended=ended,
        )

    def reset(self) -> None:
        self.sample_cursor = 0
        self.speech_start = None
        self.last_speech_sample = 0

