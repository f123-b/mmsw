# Audio P0 root cause and remediation log

Date: 2026-08-30
Branch: `codex/overlay-designer-7`

## Root cause

The interview start path had two coupled gates. The renderer disabled `开始面试` unless the latest probe reported both microphone and system streams as healthy, and `AudioManager.start()` repeated the same check. The probe also cleared the previous result before launching, so a timeout, crash, or temporary device change destroyed the only known-good state.

The sidecar compounded this with a coupled capture loop: it opened both streams as mandatory, started both as a single operation, and emitted PCM only while both queues had a full packet. A valid microphone-only or system-only session therefore became a global failure. The old loopback implementation also hid device fallback, structured per-channel errors, and first-callback timing.

## Remediation

- Probe is diagnostic only. Formal capture starts from the selected/default devices without consulting probe state.
- Each channel is opened, started, timed, and reported independently. Silent callbacks are usable; only both channels unavailable is fatal.
- Capture mode is explicit: `dual`, `system_only`, or `mic_only`. Missing PCM channels are zero-filled while preserving the 16 kHz stereo packet contract.
- Windows uses cpal's WASAPI render-endpoint loopback path (`AUDCLNT_STREAMFLAGS_LOOPBACK`), with selected → default → first-device fallback.
- Protocol events now carry channel state, capture mode, structured error codes, first-callback timing, and probe trace stages.
- `lastKnownGood` is retained separately from the latest probe attempt; diagnostics include sidecar, enumeration, capability, trace, and stderr tail data.
- Tests and E2E scenarios no longer treat a partial probe as a formal-start blocker.
