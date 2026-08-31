import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { terminateGracefully } from "./managed-process";

export type NativeModifier = "ctrl" | "alt" | "shift";

interface NativeModifierEvent { event: "modifier"; modifier: NativeModifier; pressed: boolean; }

/** Reads modifier state from the Windows low-level keyboard hook. */
export class NativeModifierShortcutManager {
  private child?: ChildProcess;
  private buffer = "";

  constructor(private readonly executable: string, private readonly onEvent: (event: NativeModifierEvent) => void, private readonly onDiagnostic?: (message: string) => void) {}

  start(): boolean {
    if (this.child || !existsSync(this.executable) || process.platform !== "win32") return false;
    const child = spawn(this.executable, ["--mode", "keyboard-watch"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as NativeModifierEvent & { error?: string };
          if (event.event === "modifier") this.onEvent(event);
          else if ((event as { event?: string }).event === "error") this.onDiagnostic?.(`NATIVE_MODIFIER_ERROR: ${event.error ?? "unknown"}`);
        } catch { /* ignore helper noise */ }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.onDiagnostic?.(`NATIVE_MODIFIER_STDERR: ${chunk.trim().slice(0, 240)}`));
    child.on("exit", (code) => { if (this.child === child) this.child = undefined; if (code && code !== 0) this.onDiagnostic?.(`NATIVE_MODIFIER_EXIT: ${code}`); });
    child.on("error", (error) => { if (this.child === child) this.child = undefined; this.onDiagnostic?.(`NATIVE_MODIFIER_FAILED: ${error.message}`); });
    return true;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const result = await terminateGracefully(child, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 750,
      onEvent: (event, fields) => this.onDiagnostic?.(`${event}: pid=${fields.pid ?? "unknown"}`)
    });
    if (this.child === child) this.child = undefined;
    if (!result.exited) this.onDiagnostic?.(`NATIVE_MODIFIER_EXIT_TIMEOUT: pid=${child.pid ?? "unknown"}`);
  }
}
