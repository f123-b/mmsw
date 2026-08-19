import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  audioDevicesSchema,
  parseAudioSidecarEvent,
  type AudioDevices,
  type AudioSidecarEvent,
  type ProbeResult
} from "@interview-copilot/protocol";
import { PcmPacketAssembler } from "./pcm-packet-assembler";

export type AudioProcessState = "stopped" | "running";
export type AudioProcessKind = "probe" | "meter" | "capture";

export interface AudioStartOptions {
  inputDeviceId?: string;
  outputDeviceId?: string;
  meterOnly?: boolean;
  probeOnly?: boolean;
  autoRecover?: boolean;
}

const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
const STABLE_READY_MS = 2_000;

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

export class AudioManager extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private processKind: AudioProcessKind | undefined;
  private processExitPromise: Promise<void> | undefined;
  private resolveProcessExit: (() => void) | undefined;
  private stderrBuffer = "";
  private retryTimer: NodeJS.Timeout | undefined;
  private stableReadyTimer: NodeJS.Timeout | undefined;
  private readonly recoveryBackoff = new RecoveryBackoff();
  private readonly pcmAssembler = new PcmPacketAssembler();
  private manualStop = true;
  private currentOptions: AudioStartOptions = {};
  private pendingProbe: {
    resolve: (result: ProbeResult) => void;
    reject: (error: Error) => void;
    result?: ProbeResult;
    timer: NodeJS.Timeout;
  } | undefined;
  private probeInFlight: { key: string; promise: Promise<ProbeResult> } | undefined;
  private lastProbeResult: ProbeResult | undefined;
  private lastProbeDeviceKey: string | undefined;

  get configuredPath(): string {
    return sidecarPath();
  }

  get isRunning(): boolean {
    return Boolean(this.process);
  }

  get runningKind(): AudioProcessKind | undefined { return this.processKind; }
  get runningOptions(): AudioStartOptions { return { ...this.currentOptions }; }

  hasValidProbe(options: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId"> = {}): boolean {
    return Boolean(this.lastProbeResult?.mic.streamOk && this.lastProbeResult.system.streamOk && this.lastProbeDeviceKey === this.probeDeviceKey(options));
  }

  async listDevices(): Promise<AudioDevices> {
    const executable = this.requireSidecar();
    const command = this.sidecarCommand(executable, ["--list-devices", "--json"]);
    const child = spawn(command.command, command.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = await this.collectStdout(child);
    return audioDevicesSchema.parse(JSON.parse(stdout));
  }

  async start(options: AudioStartOptions = {}): Promise<void> {
    if (this.isRunning) throw new Error(`AUDIO_BUSY: ${this.processKind ?? "audio"} sidecar is still running`);
    if (this.pendingProbe) throw new Error("AUDIO_BUSY: audio probe is still settling");
    if (!options.meterOnly && !options.probeOnly && !this.hasValidProbe(options)) throw new Error("AUDIO_PROBE_REQUIRED: a successful mic and system probe is required before formal capture");
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.manualStop = false;
    this.recoveryBackoff.reset();
    this.currentOptions = { ...options, autoRecover: options.autoRecover ?? true };
    this.spawnSidecar(this.currentOptions, options.probeOnly ? "probe" : options.meterOnly ? "meter" : "capture");
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.recoveryBackoff.reset();
    this.pcmAssembler.reset();
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
    if (!this.process) return;
    if (this.process === child) {
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

  probe(options: Omit<AudioStartOptions, "meterOnly" | "probeOnly" | "autoRecover"> = {}): Promise<ProbeResult> {
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

  private runProbe(options: Omit<AudioStartOptions, "meterOnly" | "probeOnly" | "autoRecover">): Promise<ProbeResult> {
    // A new probe is the only operation allowed to establish a fresh validity
    // window. Invalidate the previous success before spawning so a timeout,
    // crash, or empty result can never reuse it.
    this.lastProbeResult = undefined;
    this.lastProbeDeviceKey = undefined;
    if (this.isRunning) return Promise.reject(new Error(`AUDIO_BUSY: ${this.processKind ?? "audio"} sidecar is still running`));
    const result = new Promise<ProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingProbe) return;
        const pending = this.pendingProbe;
        this.pendingProbe = undefined;
        clearTimeout(pending.timer);
        const error = new Error("AUDIO_PROBE_TIMEOUT: probe did not complete in time");
        void this.stop().finally(() => pending.reject(error));
      }, Math.max(50, Number(process.env.INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS ?? 15_000)));
      this.pendingProbe = { resolve, reject, timer };
    });
    try {
      this.clearRecoveryTimer();
      this.clearStableReadyTimer();
      this.manualStop = false;
      this.recoveryBackoff.reset();
      this.currentOptions = { ...options, probeOnly: true, autoRecover: false };
      // `pendingProbe` is intentionally installed before spawning so that a
      // very fast sidecar cannot race past the result handler. Calling the
      // public start() here would reject that pending operation as AUDIO_BUSY.
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
      this.emitEvent({
        type: "audio_error",
        component: "process",
        reason: `Audio Sidecar not found: ${executable}`,
        recoverable: false,
        timestamp: Date.now()
      });
      this.emitEvent({ type: "audio_state", state: "FAILED", timestamp: Date.now() });
      throw new Error(`SIDECAR_NOT_FOUND: Audio Sidecar not found: ${executable}`);
    }

    const args = [
      ...(options.inputDeviceId ? ["--input-device-id", options.inputDeviceId] : []),
      ...(options.outputDeviceId ? ["--output-device-id", options.outputDeviceId] : []),
      ...(options.probeOnly ? ["--probe-only"] : []),
      ...(options.meterOnly ? ["--meter-only"] : [])
    ];
    this.stderrBuffer = "";
    this.pcmAssembler.reset();
    const command = this.sidecarCommand(executable, args);
    this.process = spawn(command.command, command.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const child = this.process;
    this.processKind = kind;
    this.processExitPromise = new Promise<void>((resolve) => { this.resolveProcessExit = resolve; });
    this.emit("process", "running" as AudioProcessState);

    child.stdout.on("data", (chunk: Buffer) => {
      for (const packet of this.pcmAssembler.push(chunk)) {
        this.emit("pcm-packet", packet);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(chunk.toString("utf8")));
    child.on("error", (error) => {
      this.emitEvent({
        type: "audio_error",
        component: "process",
        reason: error.message,
        recoverable: true,
        timestamp: Date.now()
      });
      if (this.pendingProbe) this.rejectPendingProbe(new Error(`AUDIO_PROBE_PROCESS_CRASHED: ${error.message}`));
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
      if (kind === "probe" && this.pendingProbe) {
        const pending = this.pendingProbe;
        this.pendingProbe = undefined;
        clearTimeout(pending.timer);
        const result = pending.result;
        if (!result) pending.reject(new Error(`${code === 0 ? "AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT" : "AUDIO_PROBE_PROCESS_CRASHED"}: probe exited with code ${code ?? "unknown"}`));
        else if (code !== 0) pending.reject(new Error(`AUDIO_PROBE_PROCESS_FAILED: probe exited with code ${code ?? "unknown"} after returning a result`));
        else if (!result.mic.streamOk && !result.system.streamOk) pending.reject(new Error("AUDIO_PROBE_FAILED: microphone and system audio probe failed"));
        else if (!result.mic.streamOk) pending.reject(new Error("AUDIO_PROBE_MIC_FAILED: microphone probe failed"));
        else if (!result.system.streamOk) pending.reject(new Error("AUDIO_PROBE_SYSTEM_FAILED: system audio probe failed"));
        else {
          this.lastProbeResult = result;
          this.lastProbeDeviceKey = this.probeDeviceKey(options);
          pending.resolve(result);
        }
      }
      if (!wasExpected && options.autoRecover !== false) {
        this.emitEvent({ type: "audio_state", state: "DEGRADED", timestamp: Date.now() });
        if (code !== 0) {
          this.emitEvent({
            type: "audio_error",
            component: "process",
            reason: `Audio Sidecar exited with code ${code ?? "unknown"}`,
            recoverable: true,
            timestamp: Date.now()
          });
        }
        this.scheduleRecovery();
      }
    });
  }

  private scheduleRecovery(): void {
    if (this.manualStop || this.retryTimer) return;
    const delay = this.recoveryBackoff.nextDelayMs();
    this.emitEvent({ type: "audio_state", state: "DEGRADED", timestamp: Date.now() });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.recover();
    }, delay);
  }

  private async recover(): Promise<void> {
    if (this.manualStop || this.isRunning) return;
    this.emitEvent({ type: "audio_state", state: "RECOVERING", timestamp: Date.now() });
    try {
      const devices = await this.listDevices();
      const inputExists = !this.currentOptions.inputDeviceId || devices.inputs.some((device) => device.id === this.currentOptions.inputDeviceId);
      const outputExists = !this.currentOptions.outputDeviceId || devices.outputs.some((device) => device.id === this.currentOptions.outputDeviceId);
      this.currentOptions = {
        ...this.currentOptions,
        inputDeviceId: inputExists ? this.currentOptions.inputDeviceId : undefined,
        outputDeviceId: outputExists ? this.currentOptions.outputDeviceId : undefined
      };
    } catch (error) {
      this.emit("diagnostic", `Audio recovery device enumeration failed: ${String(error)}`);
    }
    if (!this.manualStop) this.spawnSidecar(this.currentOptions, this.currentOptions.meterOnly ? "meter" : "capture");
  }

  private clearRecoveryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearStableReadyTimer(): void {
    if (this.stableReadyTimer) clearTimeout(this.stableReadyTimer);
    this.stableReadyTimer = undefined;
  }

  private requireSidecar(): string {
    const executable = this.configuredPath;
    if (!existsSync(executable)) throw new Error(`Audio Sidecar not found: ${executable}`);
    return executable;
  }

  private sidecarCommand(executable: string, args: string[]): { command: string; args: string[] } {
    if (/\.(?:mjs|js)$/i.test(executable)) return { command: process.env.INTERVIEW_COPILOT_NODE_EXECUTABLE ?? "node", args: [executable, ...args] };
    return { command: executable, args };
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emitEvent(parseAudioSidecarEvent(line));
      } catch {
        this.emit("diagnostic", line.trim());
      }
    }
  }

  private emitEvent(event: AudioSidecarEvent): void {
    if (event.type === "probe_result" && this.pendingProbe) {
      this.pendingProbe.result = event;
      this.lastProbeResult = undefined;
      this.lastProbeDeviceKey = undefined;
    }
    if (event.type === "audio_state" && event.state === "READY") {
      this.clearStableReadyTimer();
      const readyProcess = this.process;
      this.stableReadyTimer = setTimeout(() => {
        this.stableReadyTimer = undefined;
        if (!this.manualStop && this.process === readyProcess && this.isRunning) {
          this.recoveryBackoff.reset();
        }
      }, STABLE_READY_MS);
    }
    this.emit("event", event);
  }

  private rejectPendingProbe(error: Error): void {
    const pending = this.pendingProbe;
    if (!pending) return;
    this.pendingProbe = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private collectStdout(child: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(output.trim());
        else reject(new Error(errorOutput.trim() || `Audio Sidecar exited with code ${code}`));
      });
    });
  }

  private probeDeviceKey(options: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): string {
    return `${options.inputDeviceId ?? ""}::${options.outputDeviceId ?? ""}`;
  }
}
