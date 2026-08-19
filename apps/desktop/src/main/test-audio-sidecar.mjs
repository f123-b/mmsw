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
    if (process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR === "exit-without-result") {
      process.exit(0);
      return;
    }
    if (process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR === "timeout") return;
    emit({ type: "probe_result", mic: { ok: true, sampleRate: 16_000, channels: 1, peak: 0.4, callbackCount: 4, sampleCount: 640 }, system: { ok: true, sampleRate: 16_000, channels: 2, peak: 0.3, callbackCount: 4, sampleCount: 1_280 }, durationMs: 40, timestamp: timestamp() });
    emit({ type: "audio_state", state: "READY", timestamp: timestamp() });
    process.exit(0);
  }, 40);
} else {
  emit({ type: "audio_state", state: "READY", timestamp: timestamp() });
  const packet = Buffer.alloc(2_560, 1);
  const timer = setInterval(() => process.stdout.write(packet), 20);
  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
}
