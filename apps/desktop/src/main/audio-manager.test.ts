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

describe("AudioManager probe lifecycle", () => {
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

  it("PROBE_COMPLETES_BEFORE_INTERVIEW_START", async () => {
    const result = await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(result.mic.ok && result.system.ok).toBe(true);
    expect(manager.isRunning).toBe(false);
    await manager.start({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system", meterOnly: false, autoRecover: true });
    expect(manager.runningKind).toBe("capture");
    expect(manager.runningOptions.meterOnly).toBe(false);
  });

  it("PROBE_TIMEOUT", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "timeout";
    process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS = "100";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_TIMEOUT");
    expect(manager.isRunning).toBe(false);
  });

  it("PROBE_PROCESS_EXIT_WITHOUT_RESULT", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "exit-without-result";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT");
  });

  it("PROBE_MIC_FAILED_BLOCKS_START", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "mic-fail";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_MIC_FAILED");
    await expect(manager.start({ meterOnly: false })).rejects.toThrow("AUDIO_PROBE_REQUIRED");
  });

  it("PROBE_SYSTEM_FAILED_BLOCKS_START", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "system-fail";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_SYSTEM_FAILED");
    await expect(manager.start({ meterOnly: false })).rejects.toThrow("AUDIO_PROBE_REQUIRED");
  });

  it("PROBE_BOTH_FAILED_BLOCKS_START", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "both-fail";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_FAILED");
    await expect(manager.start({ meterOnly: false })).rejects.toThrow("AUDIO_PROBE_REQUIRED");
  });

  it("PROBE_EXIT_NONZERO_AFTER_RESULT", async () => {
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "nonzero-after-result";
    await expect(manager.probe()).rejects.toThrow("AUDIO_PROBE_PROCESS_FAILED");
    await expect(manager.start({ meterOnly: false })).rejects.toThrow("AUDIO_PROBE_REQUIRED");
  });

  it("PROBE_DEVICE_CHANGE_INVALIDATES_RESULT", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    await expect(manager.start({ inputDeviceId: "another-mic", outputDeviceId: "mock-system", meterOnly: false })).rejects.toThrow("AUDIO_PROBE_REQUIRED");
  });

  it("PROBE_SECOND_ATTEMPT_INVALIDATES_OLD_SUCCESS", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(true);
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "timeout";
    process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS = "100";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_TIMEOUT");
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(false);
  });

  it("PROBE_CRASH_INVALIDATES_OLD_SUCCESS", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(true);
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "crash";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_PROCESS_CRASHED");
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(false);
  });

  it("PROBE_EXIT_WITHOUT_RESULT_INVALIDATES_OLD_SUCCESS", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(true);
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "exit-without-result";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT");
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(false);
  });

  it("PROBE_FAILED_RESULT_INVALIDATES_OLD_SUCCESS", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(true);
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "mic-fail";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_MIC_FAILED");
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(false);
  });

  it("PROBE_SUCCESS_REVALIDATES_CURRENT_DEVICES", async () => {
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR = "timeout";
    process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS = "100";
    await expect(manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).rejects.toThrow("AUDIO_PROBE_TIMEOUT");
    delete process.env.INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR;
    delete process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS;
    await manager.probe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" });
    expect(manager.hasValidProbe({ inputDeviceId: "mock-mic", outputDeviceId: "mock-system" })).toBe(true);
  });

  it("INTERVIEW_START_WHILE_PROBE_RUNNING", async () => {
    const probe = manager.probe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(manager.start({ meterOnly: false })).rejects.toThrow("AUDIO_BUSY");
    await probe;
  });

  it("PROBE_SUCCESS_ALLOWS_FORMAL_CAPTURE", async () => {
    await manager.probe();
    await manager.start({ meterOnly: false, autoRecover: true });
    expect(manager.runningOptions).toMatchObject({ meterOnly: false, autoRecover: true });
  });
});
