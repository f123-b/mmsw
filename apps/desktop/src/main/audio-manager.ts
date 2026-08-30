import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  audioDevicesSchema,
  parseAudioSidecarEvent,
  type AudioCapability,
  type AudioDevices,
  type AudioProbeTrace,
  type AudioSidecarEvent,
  type ProbeResult
} from "@interview-copilot/protocol";
import { PcmPacketAssembler } from "./pcm-packet-assembler";
import { resolveAudioCapturePolicy } from "./audio-policy";

export type AudioProcessState = "stopped" | "running";
export type AudioProcessKind = "probe" | "meter" | "capture";

export interface AudioStartOptions {
  inputDeviceId?: string;
  outputDeviceId?: string;
  captureMode?: "dual" | "system_only" | "mic_only";
  meterOnly?: boolean;
  probeOnly?: boolean;
  autoRecover?: boolean;
}

export interface AudioDiagnosticsReport {
  sidecarPath: string;
  sidecarExists: boolean;
  sidecarVersion: string;
  processKind?: AudioProcessKind;
  running: boolean;
  selectedInputDeviceId?: string;
  selectedOutputDeviceId?: string;
  captureMode?: AudioCapability["captureMode"];
  capability?: AudioCapability;
  devices?: AudioDevices;
  lastKnownGood?: { deviceKey: string; result: ProbeResult; recordedAt: number };
  latestProbe?: ProbeResult;
  trace: AudioProbeTrace[];
  stderrTail: string;
  generatedAt: number;
}

const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
const STABLE_READY_MS = 2_000;
const DEFAULT_PROBE_TIMEOUT_MS = 4_500;

export function reconnectDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), RECOVERY_DELAYS_MS.length - 1));
  return RECOVERY_DELAYS_MS[index];
}

export class RecoveryBackoff {
  private attempt = 0;

  nextDelayMs(): number {
    const delay = reconnectDelayMs(this.attempt);
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}

function sidecarPath(): string {
  const configured = process.env.INTERVIEW_COPILOT_AUDIO_SIDECAR;
  if (configured) return configured;
  const binaryName = process.platform === "win32" ? "interview-audio.exe" : "interview-audio";
  const candidates = [
    join(process.resourcesPath, "audio-sidecar", binaryName),
    join(process.cwd(), "crates", "audio-sidecar", "target", "release", binaryName),
    join(__dirname, "../../../../crates", "audio-sidecar", "target", "release", binaryName)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function probeTimeoutMs(): number {
  const value = Number(process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS ?? DEFAULT_PROBE_TIMEOUT_MS);
  return Math.max(250, Math.min(Number.isFinite(value) ? value : DEFAULT_PROBE_TIMEOUT_MS, 5_000));
}

export class AudioManager extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private processKind: AudioProcessKind | undefined;
  private processExitPromise: Promise<void> | undefined;
  private resolveProcessExit: (() => void) | undefined;
  private stderrBuffer = "";
  private stderrTail = "";
  private retryTimer: NodeJS.Timeout | undefined;
  private stableReadyTimer: NodeJS.Timeout | undefined;
  private readonly recoveryBackoff = new RecoveryBackoff();
  private readonly pcmAssembler = new PcmPacketAssembler();
  private manualStop = true;
  private currentOptions: AudioStartOptions = {};
  private capability: AudioCapability | undefined;
  private latestProbeResult: ProbeResult | undefined;
  private lastKnownGood: { deviceKey: string; result: ProbeResult; recordedAt: number } | undefined;
  private trace: AudioProbeTrace[] = [];
  private lastDevices: AudioDevices | undefined;
  private pendingStart: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private pendingProbe: {
    resolve: (result: ProbeResult) => void;
    reject: (error: Error) => void;
    result?: ProbeResult;
    timer: NodeJS.Timeout;
  } | undefined;
  private probeInFlight: { key: string; promise: Promise<ProbeResult> } | undefined;

  get configuredPath(): string { return sidecarPath(); }
  get isRunning(): boolean { return Boolean(this.process); }
  get runningKind(): AudioProcessKind | undefined { return this.processKind; }
  get runningOptions(): AudioStartOptions { return { ...this.currentOptions }; }
  get currentCapability(): AudioCapability | undefined { return this.capability; }

  async listDevices(): Promise<AudioDevices> {
    const executable = this.requireSidecar();
    const command = this.sidecarCommand(executable, ["--list-devices", "--json"]);
    const child = spawn(command.command, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = await this.collectStdout(child);
    const devices = audioDevicesSchema.parse(JSON.parse(stdout));
    this.lastDevices = devices;
    return devices;
  }

  getDiagnostics(): AudioDiagnosticsReport {
    return {
      sidecarPath: this.configuredPath,
      sidecarExists: existsSync(this.configuredPath),
      sidecarVersion: "interview-audio/0.1.0",
      processKind: this.processKind,
      running: this.isRunning,
      selectedInputDeviceId: this.currentOptions.inputDeviceId,
      selectedOutputDeviceId: this.currentOptions.outputDeviceId,
      captureMode: this.capability?.captureMode,
      capability: this.capability,
      devices: this.lastDevices,
      lastKnownGood: this.lastKnownGood,
      latestProbe: this.latestProbeResult,
      trace: [...this.trace],
      stderrTail: this.stderrTail.slice(-4_000),
      generatedAt: Date.now()
    };
  }

  async start(options: AudioStartOptions = {}): Promise<void> {
    if (this.isRunning && this.processKind !== "probe") throw new Error(`AUDIO_BUSY: ${this.processKind ?? "audio"} sidecar is still running`);
    if (this.pendingProbe) await this.stop();
    if (this.isRunning) throw new Error(`AUDIO_BUSY: ${this.processKind ?? "audio"} sidecar is still running`);
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.manualStop = false;
    this.recoveryBackoff.reset();
    this.capability = undefined;
    this.currentOptions = { ...options, autoRecover: options.autoRecover ?? true };
    const kind: AudioProcessKind = options.probeOnly ? "probe" : options.meterOnly ? "meter" : "capture";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingStart) return;
        this.pendingStart = undefined;
        reject(new Error("AUDIO_CAPTURE_TIMEOUT: audio capture did not report a capability in time"));
        void this.stop();
      }, kind === "capture" ? 5_000 : 2_000);
      this.pendingStart = { resolve, reject, timer };
    });
    try {
      this.spawnSidecar(this.currentOptions, kind);
    } catch (error) {
      this.rejectPendingStart(error instanceof Error ? error : new Error(String(error)));
    }
    return ready;
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.recoveryBackoff.reset();
    this.pcmAssembler.reset();
    this.rejectPendingStart(new Error("AUDIO_STOPPED: audio capture was stopped before readiness"));
    const pendingProbe = this.pendingProbe;
    this.pendingProbe = undefined;
    if (pendingProbe) {
      clearTimeout(pendingProbe.timer);
      pendingProbe.reject(new Error("AUDIO_PROBE_STOPPED: audio probe was stopped before completion"));
    }
    const child = this.process;
    const exit = this.processExitPromise;
    if (child && !child.killed) child.kill();
    if (child && exit) await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (this.process === child && child) {
      this.process = undefined;
      this.processKind = undefined;
      this.processExitPromise = undefined;
      this.resolveProcessExit?.();
      this.resolveProcessExit = undefined;
      this.emit("process", "stopped" as AudioProcessState);
    }
  }

  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    if (!this.process) return;
    const process = this.process;
    const exit = this.processExitPromise;
    if (exit) await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    if (this.process === process) throw new Error("AUDIO_BUSY: audio sidecar did not stop in time");
  }

  probe(options: Omit<AudioStartOptions, "meterOnly" | "probeOnly" | "autoRecover" | "captureMode"> = {}): Promise<ProbeResult> {
    const key = this.probeDeviceKey(options);
    if (this.probeInFlight) {
      if (this.probeInFlight.key === key) return this.probeInFlight.promise;
      return Promise.reject(new Error("AUDIO_PROBE_BUSY: another audio probe is already running"));
    }
    const promise = this.runProbe(options);
    let tracked!: Promise<ProbeResult>;
    tracked = promise.finally(() => {
      if (this.probeInFlight?.promise === tracked) this.probeInFlight = undefined;
    });
    this.probeInFlight = { key, promise: tracked };
    return tracked;
  }

  private runProbe(options: Omit<AudioStartOptions, "meterOnly" | "probeOnly" | "autoRecover" | "captureMode">): Promise<ProbeResult> {
    if (this.isRunning) return Promise.reject(new Error(`AUDIO_BUSY: ${this.processKind ?? "audio"} sidecar is still running`));
    const result = new Promise<ProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingProbe) return;
        const pending = this.pendingProbe;
        this.pendingProbe = undefined;
        clearTimeout(pending.timer);
        void this.stop().finally(() => pending.reject(new Error("AUDIO_PROBE_TIMEOUT: probe did not complete in time")));
      }, probeTimeoutMs());
      this.pendingProbe = { resolve, reject, timer };
    });
    try {
      this.clearRecoveryTimer();
      this.clearStableReadyTimer();
      this.manualStop = false;
      this.recoveryBackoff.reset();
      this.currentOptions = { ...options, probeOnly: true, autoRecover: false };
      this.spawnSidecar(this.currentOptions, "probe");
    } catch (error) {
      const pending = this.pendingProbe;
      this.pendingProbe = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  private spawnSidecar(options: AudioStartOptions, kind: AudioProcessKind): void {
    const executable = this.configuredPath;
    if (!existsSync(executable)) {
      this.manualStop = true;
      const error = new Error(`SIDECAR_NOT_FOUND: Audio Sidecar not found: ${executable}`);
      this.emitEvent({ type: "audio_error", component: "process", code: "SIDECAR_NOT_FOUND", reason: error.message, recoverable: false, timestamp: Date.now() });
      this.emitEvent({ type: "audio_state", state: "FAILED", timestamp: Date.now() });
      throw error;
    }

    const args = [
      ...(options.inputDeviceId ? ["--input-device-id", options.inputDeviceId] : []),
      ...(options.outputDeviceId ? ["--output-device-id", options.outputDeviceId] : []),
      ...(options.captureMode ? ["--capture-mode", options.captureMode] : []),
      ...(options.probeOnly ? ["--probe-only"] : []),
      ...(options.meterOnly ? ["--meter-only"] : [])
    ];
    this.stderrBuffer = "";
    this.stderrTail = "";
    this.trace = [];
    this.pcmAssembler.reset();
    const command = this.sidecarCommand(executable, args);
    this.process = spawn(command.command, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const child = this.process;
    this.processKind = kind;
    this.processExitPromise = new Promise<void>((resolve) => { this.resolveProcessExit = resolve; });
    this.emit("process", "running" as AudioProcessState);
    this.recordTrace("sidecar_spawned", undefined, `${kind}: ${executable}`);

    child.stdout.on("data", (chunk: Buffer) => {
      for (const packet of this.pcmAssembler.push(chunk)) this.emit("pcm-packet", packet);
    });
    child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(chunk.toString("utf8")));
    child.on("error", (error) => {
      const code = kind === "probe" ? "AUDIO_PROBE_PROCESS_CRASHED" : "SIDECAR_PROCESS_FAILED";
      this.emitEvent({ type: "audio_error", component: "process", code, reason: error.message, recoverable: kind !== "probe", timestamp: Date.now() });
      if (this.pendingProbe) this.rejectPendingProbe(new Error(`${code}: ${error.message}`));
      this.rejectPendingStart(new Error(`${code}: ${error.message}`));
      if (kind !== "probe") this.scheduleRecovery();
    });
    child.on("close", (code) => {
      const wasExpected = this.manualStop || Boolean(options.probeOnly);
      this.clearStableReadyTimer();
      this.pcmAssembler.reset();
      if (this.process === child) this.process = undefined;
      if (this.processKind === kind) this.processKind = undefined;
      this.resolveProcessExit?.();
      this.resolveProcessExit = undefined;
      this.processExitPromise = undefined;
      this.emit("process", "stopped" as AudioProcessState);
      this.recordTrace("process_exited", undefined, `code=${code ?? "unknown"}`);
      if (kind === "probe" && this.pendingProbe) {
        const pending = this.pendingProbe;
        this.pendingProbe = undefined;
        clearTimeout(pending.timer);
        const result = pending.result;
        if (!result) pending.reject(new Error(`${code === 0 ? "AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT" : "AUDIO_PROBE_PROCESS_CRASHED"}: probe exited with code ${code ?? "unknown"}`));
        else if (code !== 0) pending.reject(new Error(`AUDIO_PROBE_PROCESS_FAILED: probe exited with code ${code ?? "unknown"} after returning a result`));
        else {
          const key = this.probeDeviceKey(options);
          this.latestProbeResult = result;
          this.lastKnownGood = { deviceKey: key, result, recordedAt: Date.now() };
          pending.resolve(result);
        }
      }
      if (!wasExpected && options.autoRecover !== false) {
        this.rejectPendingStart(new Error("NO_AUDIO_CHANNEL_AVAILABLE: audio sidecar exited before capture became usable"));
        this.emitEvent({ type: "audio_state", state: "DEGRADED", timestamp: Date.now() });
        if (code !== 0) this.emitEvent({ type: "audio_error", component: "process", code: "SIDECAR_PROCESS_FAILED", reason: `Audio Sidecar exited with code ${code ?? "unknown"}`, recoverable: true, timestamp: Date.now() });
        this.scheduleRecovery();
      }
    });
  }

  private scheduleRecovery(): void {
    if (this.manualStop || this.retryTimer) return;
    const delay = this.recoveryBackoff.nextDelayMs();
    this.emitEvent({ type: "audio_state", state: "DEGRADED", timestamp: Date.now() });
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.recover(); }, delay);
  }

  private async recover(): Promise<void> {
    if (this.manualStop || this.isRunning) return;
    this.emitEvent({ type: "audio_state", state: "RECOVERING", timestamp: Date.now() });
    try {
      const devices = await this.listDevices();
      const inputExists = !this.currentOptions.inputDeviceId || devices.inputs.some((device) => device.id === this.currentOptions.inputDeviceId);
      const outputExists = !this.currentOptions.outputDeviceId || devices.outputs.some((device) => device.id === this.currentOptions.outputDeviceId);
      this.currentOptions = { ...this.currentOptions, inputDeviceId: inputExists ? this.currentOptions.inputDeviceId : undefined, outputDeviceId: outputExists ? this.currentOptions.outputDeviceId : undefined };
    } catch (error) {
      this.emit("diagnostic", `Audio recovery device enumeration failed: ${String(error)}`);
    }
    if (!this.manualStop) this.spawnSidecar(this.currentOptions, this.currentOptions.meterOnly ? "meter" : "capture");
  }

  private clearRecoveryTimer(): void { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  private clearStableReadyTimer(): void { if (this.stableReadyTimer) clearTimeout(this.stableReadyTimer); this.stableReadyTimer = undefined; }
  private requireSidecar(): string { const executable = this.configuredPath; if (!existsSync(executable)) throw new Error(`SIDECAR_NOT_FOUND: Audio Sidecar not found: ${executable}`); return executable; }
  private sidecarCommand(executable: string, args: string[]): { command: string; args: string[] } {
    if (/\.(?:mjs|js)$/i.test(executable)) return { command: process.env.INTERVIEW_COPILOT_NODE_EXECUTABLE ?? "node", args: [executable, ...args] };
    return { command: executable, args };
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.emitEvent(parseAudioSidecarEvent(line)); }
      catch { this.emit("diagnostic", line.trim()); }
    }
  }

  private emitEvent(event: AudioSidecarEvent): void {
    if (event.type === "audio_probe_trace") {
      this.trace = [...this.trace.slice(-99), event];
    }
    if (event.type === "probe_result") {
      if (this.pendingProbe) this.pendingProbe.result = event;
      this.latestProbeResult = event;
      this.recordTrace("result_emitted", undefined, event.captureMode ?? "probe");
    }
    if (event.type === "audio_capability") {
      this.capability = event;
      this.resolvePendingStartIfUsable(event);
    }
    if (event.type === "audio_state" && event.state === "READY") {
      this.clearStableReadyTimer();
      const readyProcess = this.process;
      this.stableReadyTimer = setTimeout(() => {
        this.stableReadyTimer = undefined;
        if (!this.manualStop && this.process === readyProcess && this.isRunning) this.recoveryBackoff.reset();
      }, STABLE_READY_MS);
      if (this.processKind === "meter" && this.pendingStart) this.resolvePendingStart();
    }
    if (event.type === "audio_error" && !event.recoverable && ["SIDECAR_NOT_FOUND", "NO_AUDIO_CHANNEL_AVAILABLE", "PROTOCOL_BROKEN"].includes(event.code ?? "")) this.rejectPendingStart(new Error(`${event.code}: ${event.reason}`));
    this.emit("event", event);
  }

  private resolvePendingStartIfUsable(event: AudioCapability): void {
    try { resolveAudioCapturePolicy(event.mic, event.system); }
    catch { return; }
    this.resolvePendingStart();
  }

  private resolvePendingStart(): void {
    const pending = this.pendingStart;
    if (!pending) return;
    this.pendingStart = undefined;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectPendingStart(error: Error): void {
    const pending = this.pendingStart;
    if (!pending) return;
    this.pendingStart = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingProbe(error: Error): void {
    const pending = this.pendingProbe;
    if (!pending) return;
    this.pendingProbe = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private recordTrace(stage: AudioProbeTrace["stage"], channel?: "mic" | "system", details?: string): void {
    const event: AudioProbeTrace = { type: "audio_probe_trace", stage, ...(channel ? { channel } : {}), elapsedMs: 0, ...(details ? { details } : {}), timestamp: Date.now() };
    this.trace = [...this.trace.slice(-99), event];
    this.emit("trace", event);
  }

  private collectStdout(child: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errorOutput.trim() || `Audio Sidecar exited with code ${code}`)));
    });
  }

  private probeDeviceKey(options: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): string {
    return `${options.inputDeviceId ?? ""}::${options.outputDeviceId ?? ""}`;
  }
}
