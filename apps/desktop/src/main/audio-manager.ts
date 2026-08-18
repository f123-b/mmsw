import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  audioDevicesSchema,
  parseAudioSidecarEvent,
  type AudioDevices,
  type AudioSidecarEvent
} from "@interview-copilot/protocol";
import { PcmPacketAssembler } from "./pcm-packet-assembler";

export type AudioProcessState = "stopped" | "running";

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
  return join(process.resourcesPath, "audio-sidecar", binaryName);
}

export class AudioManager extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private stderrBuffer = "";
  private retryTimer: NodeJS.Timeout | undefined;
  private stableReadyTimer: NodeJS.Timeout | undefined;
  private readonly recoveryBackoff = new RecoveryBackoff();
  private readonly pcmAssembler = new PcmPacketAssembler();
  private manualStop = true;
  private currentOptions: AudioStartOptions = {};

  get configuredPath(): string {
    return sidecarPath();
  }

  get isRunning(): boolean {
    return Boolean(this.process && !this.process.killed);
  }

  async listDevices(): Promise<AudioDevices> {
    const executable = this.requireSidecar();
    const child = spawn(executable, ["--list-devices", "--json"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = await this.collectStdout(child);
    return audioDevicesSchema.parse(JSON.parse(stdout));
  }

  start(options: AudioStartOptions = {}): void {
    if (this.isRunning) return;
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.manualStop = false;
    this.recoveryBackoff.reset();
    this.currentOptions = { ...options, autoRecover: options.autoRecover ?? true };
    this.spawnSidecar(this.currentOptions);
  }

  stop(): void {
    this.manualStop = true;
    this.clearRecoveryTimer();
    this.clearStableReadyTimer();
    this.recoveryBackoff.reset();
    this.pcmAssembler.reset();
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.emit("process", "stopped" as AudioProcessState);
  }

  probe(options: Omit<AudioStartOptions, "meterOnly" | "probeOnly" | "autoRecover"> = {}): void {
    this.start({ ...options, probeOnly: true, autoRecover: false });
  }

  private spawnSidecar(options: AudioStartOptions): void {
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
      return;
    }

    const args = [
      ...(options.inputDeviceId ? ["--input-device-id", options.inputDeviceId] : []),
      ...(options.outputDeviceId ? ["--output-device-id", options.outputDeviceId] : []),
      ...(options.probeOnly ? ["--probe-only"] : []),
      ...(options.meterOnly ? ["--meter-only"] : [])
    ];
    this.stderrBuffer = "";
    this.pcmAssembler.reset();
    this.process = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const child = this.process;
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
      this.scheduleRecovery();
    });
    child.on("close", (code) => {
      const wasExpected = this.manualStop || Boolean(options.probeOnly);
      this.clearStableReadyTimer();
      this.pcmAssembler.reset();
      if (this.process === child) this.process = undefined;
      this.emit("process", "stopped" as AudioProcessState);
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
    if (!this.manualStop) this.spawnSidecar(this.currentOptions);
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
}
