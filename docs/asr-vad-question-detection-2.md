# ASR / VAD / Question Detection 2.0

## Runtime flow

```text
Rust Audio Sidecar (stereo PCM16)
        |
        v
Silero-compatible VAD gate (desktop fallback)
        |
        v
ASRManager / compatible RealtimeSession port
        |
        v
TranscriptStabilizer -> TranscriptAggregator -> QuestionDetector
                                      |
                                      v
                              AnswerAgent / RAG
```

`ASRManager` is the shared provider orchestration layer. The existing desktop `RealtimeSession` remains as the backward-compatible event/reconnect port while direct Deepgram, Qwen, Custom Gateway, and Local Fun-ASR traffic are migrated incrementally.

## Provider contract

New provider code lives under `packages/shared/src/asr/`:

- `types.ts`: `ASRConfig`, `ASRStatus`, transcript and socket types.
- `asr-provider.ts`: `ASRProvider` and provider factory.
- `asr-manager.ts`: stereo channel routing and provider switching.
- `providers/`: Deepgram facade, Gateway adapter, and Local Fun-ASR WebSocket adapter.

Whisper.cpp or SenseVoice can be added by implementing `ASRProvider`, returning the same transcript segment shape, and registering a factory branch. No InterviewCoordinator or AnswerAgent changes are required.

## Question Detection 2.0

`QuestionDetector2` calculates `0.3 * ruleScore + 0.5 * semanticScore + 0.2 * llmScore`. It calls the optional LLM confirmer only in the low-confidence band; explicit prompts such as `介绍一下你的项目` stay local and filler such as `嗯` is rejected locally.

