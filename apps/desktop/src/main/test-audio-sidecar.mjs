const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const timestamp = () => Date.now();

if (has("--list-devices")) {
  process.stdout.write(JSON.stringify({ inputs: [{ id: "mock-mic", name: "Mock Microphone", kind: "microphone", default: true }], outputs: [{ id: "mock-system", name: "Mock System Audio", kind: "loopback", default: true }] }));
  process.exit(0);
}

const emit = (value) => process.stderr.write(`${JSON.stringify(value)}\n`);
if (has("--probe-only")) {
  emit({ type: "audio_state", state: "STARTING", timestamp: timestamp() });
  setTimeout(() => {
    const behavior = process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR;
    if (behavior === "exit-without-result") {
      process.exit(0);
      return;
    }
    if (behavior === "crash") {
      process.exit(9);
      return;
    }
    if (behavior === "timeout") {
      const keepAlive = setInterval(() => undefined, 1_000);
      process.once("SIGTERM", () => { clearInterval(keepAlive); process.exit(0); });
      return;
    }
    const micOk = behavior !== "mic-fail" && behavior !== "both-fail";
    const systemOk = behavior !== "system-fail" && behavior !== "both-fail";
    const silent = behavior === "silent";
    const channel = (ok, deviceId, deviceName, sampleRate, channels, error, code) => ({ ok, streamOk: ok, signalDetected: ok && !silent, sampleRate, channels, peak: ok && !silent ? 0.4 : 0, callbackCount: ok ? 4 : 0, sampleCount: ok ? 640 : 0, state: ok ? (silent ? "SILENT" : "READY") : "OPEN_FAILED", deviceId, deviceName, ...(error ? { error } : {}), ...(code ? { code } : {}) });
    emit({ type: "audio_probe_trace", stage: "first_callback", channel: "mic", elapsedMs: micOk ? 20 : 0, timestamp: timestamp() });
    emit({ type: "audio_probe_trace", stage: "first_callback", channel: "system", elapsedMs: systemOk ? 22 : 0, timestamp: timestamp() });
    emit({ type: "probe_result", mic: channel(micOk, "mock-mic", "Mock Microphone", 16_000, 1, micOk ? undefined : "mock microphone open failed", micOk ? undefined : "AUDIO_STREAM_OPEN_FAILED"), system: channel(systemOk, "mock-system", "Mock System Audio", 16_000, 2, systemOk ? undefined : "mock loopback open failed", systemOk ? undefined : "AUDIO_STREAM_OPEN_FAILED"), captureMode: micOk && systemOk ? "dual" : systemOk ? "system_only" : micOk ? "mic_only" : undefined, durationMs: 40, timestamp: timestamp() });
    emit({ type: "audio_state", state: micOk || systemOk ? (micOk && systemOk ? "READY" : "DEGRADED") : "FAILED", captureMode: micOk && systemOk ? "dual" : systemOk ? "system_only" : micOk ? "mic_only" : undefined, timestamp: timestamp() });
    process.exit(behavior === "nonzero-after-result" ? 7 : 0);
  }, 40);
} else {
  const behavior = process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR;
  const micOk = behavior !== "mic-fail" && behavior !== "both-fail";
  const systemOk = behavior !== "system-fail" && behavior !== "both-fail";
  const mode = micOk && systemOk ? "dual" : systemOk ? "system_only" : micOk ? "mic_only" : undefined;
  const capability = (state, available, deviceId, deviceName, error) => ({ state, available, deviceId, deviceName, signalDetected: available, ...(error ? { error, code: "AUDIO_STREAM_OPEN_FAILED" } : {}) });
  emit({ type: "audio_probe_trace", stage: "stream_started", elapsedMs: 2, timestamp: timestamp() });
  emit({ type: "audio_capability", captureMode: mode ?? "mic_only", mic: capability(micOk ? "READY" : "OPEN_FAILED", micOk, "mock-mic", "Mock Microphone", micOk ? undefined : "mock microphone open failed"), system: capability(systemOk ? "READY" : "OPEN_FAILED", systemOk, "mock-system", "Mock System Audio", systemOk ? undefined : "mock loopback open failed"), timestamp: timestamp(), source: "capture" });
  if (!mode) {
    emit({ type: "audio_error", component: "process", code: "NO_AUDIO_CHANNEL_AVAILABLE", reason: "both mock channels failed", recoverable: false, timestamp: timestamp() });
    emit({ type: "audio_state", state: "FAILED", timestamp: timestamp() });
    process.exit(1);
  }
  emit({ type: "audio_state", state: mode === "dual" ? "READY" : "DEGRADED", captureMode: mode, timestamp: timestamp() });
  const packet = Buffer.alloc(2_560, 1);
  const timer = setInterval(() => process.stdout.write(packet), 20);
  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
}
