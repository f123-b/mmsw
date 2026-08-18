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

export type AudioManagerEvent = AudioSidecarEvent | {
  type: "audio_process";
  state: "stopped" | "running";
};

export interface AudioStartOptions {
  inputDeviceId?: string;
  outputDeviceId?: string;
  meterOnly?: boolean;
  probeOnly?: boolean;
}

function sidecarPath(): string {
  const configured = process.env.INTERVIEW_COPILOT_AUDIO_SIDECAR;
  if (configured) return configured;
  const binaryName = process.platform === "win32" ? "interview-audio.exe" : "interview-audio";
  return join(process.resourcesPath, "audio-sidecar", binaryName);
}

export class AudioManager extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private stdoutBuffer = "";

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
    const executable = this.configuredPath;
    if (!existsSync(executable)) {
      this.emit("event", {
        type: "audio_error",
        component: "process",
        reason: `Audio Sidecar not found: ${executable}`,
        recoverable: false,
        timestamp: Date.now()
      } satisfies AudioSidecarEvent);
      this.emit("event", {
        type: "audio_state",
        state: "FAILED",
        timestamp: Date.now()
      } satisfies AudioSidecarEvent);
      return;
    }

    const args = options.probeOnly
      ? ["--probe-only"]
      : options.meterOnly
      ? ["--meter-only"]
      : [
          ...(options.inputDeviceId ? ["--input-device-id", options.inputDeviceId] : []),
          ...(options.outputDeviceId ? ["--output-device-id", options.outputDeviceId] : [])
        ];
    this.stdoutBuffer = "";
    this.process = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const child = this.process;
    this.emit("event", { type: "audio_process", state: "running" } satisfies AudioManagerEvent);

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("diagnostic", chunk.toString("utf8").trim());
    });
    child.on("error", (error) => {
      this.emit("event", {
        type: "audio_error",
        component: "process",
        reason: error.message,
        recoverable: true,
        timestamp: Date.now()
      } satisfies AudioSidecarEvent);
    });
    child.on("close", () => {
      this.process = undefined;
      this.emit("event", { type: "audio_process", state: "stopped" } satisfies AudioManagerEvent);
    });
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill();
    this.process = undefined;
  }

  probe(): void {
    this.start({ probeOnly: true });
  }

  private requireSidecar(): string {
    const executable = this.configuredPath;
    if (!existsSync(executable)) {
      throw new Error(`Audio Sidecar not found: ${executable}`);
    }
    return executable;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit("event", parseAudioSidecarEvent(line));
      } catch (error) {
        this.emit("diagnostic", `Invalid sidecar event: ${String(error)}`);
      }
    }
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
