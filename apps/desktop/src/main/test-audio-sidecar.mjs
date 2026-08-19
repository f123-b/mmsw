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
    emit({ type: "probe_result", mic: { ok: behavior !== "mic-fail" && behavior !== "both-fail", sampleRate: 16_000, channels: 1, peak: behavior === "mic-fail" || behavior === "both-fail" ? 0 : 0.4, callbackCount: behavior === "mic-fail" || behavior === "both-fail" ? 0 : 4, sampleCount: behavior === "mic-fail" || behavior === "both-fail" ? 0 : 640 }, system: { ok: behavior !== "system-fail" && behavior !== "both-fail", sampleRate: 16_000, channels: 2, peak: behavior === "system-fail" || behavior === "both-fail" ? 0 : 0.3, callbackCount: behavior === "system-fail" || behavior === "both-fail" ? 0 : 4, sampleCount: behavior === "system-fail" || behavior === "both-fail" ? 0 : 1_280 }, durationMs: 40, timestamp: timestamp() });
    emit({ type: "audio_state", state: "READY", timestamp: timestamp() });
    process.exit(behavior === "nonzero-after-result" ? 7 : 0);
  }, 40);
} else {
  emit({ type: "audio_state", state: "READY", timestamp: timestamp() });
  const packet = Buffer.alloc(2_560, 1);
  const timer = setInterval(() => process.stdout.write(packet), 20);
  process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
}
