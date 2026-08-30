import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioManager, reconnectDelayMs, RecoveryBackoff } from "./audio-manager";

const sidecar = join(dirname(fileURLToPath(import.meta.url)), "test-audio-sidecar.mjs");
let manager: AudioManager;

describe("AudioManager recovery backoff", () => {
  it("uses the documented capped exponential retry sequence", () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("resets to the first delay after a stable READY period", () => {
    const backoff = new RecoveryBackoff();
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });
});

describe("AudioManager capability-driven lifecycle", () => {
  beforeEach(() => {
    process.env.INTERVIEW_COPILOT_AUDIO_SIDECAR = sidecar;
    process.env.INTERVIEW_COPILOT_NODE_EXECUTABLE = process.execPath;
    delete process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR;
    delete process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS;
    manager = new AudioManager();
  });

  afterEach(async () => {
    await manager.stop();
    delete process.env.INTERVIEW_COPILOT_AUDIO_SIDECAR;
    delete process.env.INTERVIEW_COPILOT_NODE_EXECUTABLE;
    delete process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR;
    delete process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS;
  });

  it("starts formal capture without a prior probe", async () => {
    await manager.start({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system", meterOnly: false, autoRecover: true });
    expect(manager.runningKind).toBe("capture");
    expect(manager.currentCapability?.captureMode).toBe("dual");
  });

  it.each([
    ["mic-fail", "system_only"],
    ["system-fail", "mic_only"]
  ] as const)("starts in %s degraded mode when one channel fails", async (behavior, mode) => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = behavior;
    await manager.start({ meterOnly: false, autoRecover: true });
    expect(manager.currentCapability?.captureMode).toBe(mode);
    expect(manager.isRunning).toBe(true);
  });

  it("only blocks formal capture when both channels are unavailable", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "both-fail";
    await expect(manager.start({ meterOnly: false, autoRecover: false })).rejects.toThrow("NO_AUDIO_CHANNEL_AVAILABLE");
  });

  it("returns structured partial probe results instead of rejecting one channel", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "mic-fail";
    const result = await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(result.mic.streamOk).toBe(false);
    expect(result.mic.state).toBe("OPEN_FAILED");
    expect(result.system.streamOk).toBe(true);
    expect(result.captureMode).toBe("system_only");
  });

  it("keeps the last known good probe while a later probe times out", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.getDiagnostics().lastKnownGood?.result.mic.streamOk).toBe(true);
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "timeout";
    process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS = "250";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_TIMEOUT");
    expect(manager.getDiagnostics().lastKnownGood?.result.mic.streamOk).toBe(true);
    expect(manager.getDiagnostics().lastKnownGood?.result.mic.streamOk).toBe(true);
  });

  it("treats a silent callback stream as usable", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "silent";
    const result = await manager.probe();
    expect(result.mic.streamOk).toBe(true);
    expect(result.mic.signalDetected).toBe(false);
    expect(result.mic.state).toBe("SILENT");
    expect(manager.getDiagnostics().trace.some((event) => event.stage === "result_emitted")).toBe(true);
  });

  it("allows formal capture to interrupt an optional probe", async () => {
    const probe = manager.probe();
    const probeHandled = probe.catch((error) => error as Error);
    await expect(manager.start({ meterOnly: false, autoRecover: false })).resolves.toBeUndefined();
    await expect(probeHandled).resolves.toMatchObject({ message: expect.stringContaining("AUDIO_PROBE_STOPPED") });
  });

  it("deduplicates an in-flight probe for the same device selection", async () => {
    const first = manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    const second = manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("preserves independent PCM startup diagnostics", async () => {
    await manager.start({ meterOnly: false, autoRecover: false });
    const diagnostics = manager.getDiagnostics();
    expect(diagnostics.sidecarExists).toBe(true);
    expect(diagnostics.trace.some((event) => event.stage === "sidecar_spawned")).toBe(true);
    expect(diagnostics.capability?.mic.available).toBe(true);
    expect(diagnostics.capability?.system.available).toBe(true);
  });
});
