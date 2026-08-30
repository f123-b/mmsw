import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function shouldHandleMiddleMouseShortcut(input: { interviewRunning: boolean; automationMode: "AUTO" | "MANUAL"; writtenTestRunning: boolean; middleMouseEnabled?: boolean; enabledInManualInterview?: boolean; enabledInExamMode?: boolean }): boolean {
  if (input.middleMouseEnabled === false) return false;
  if (input.writtenTestRunning) return input.enabledInExamMode !== false;
  if (input.interviewRunning && input.automationMode === "MANUAL") return input.enabledInManualInterview !== false;
  return false;
}

export function middleMouseHelperCandidates(resourcesPath: string, appPath: string, cwd = process.cwd()): string[] {
  return [
    join(resourcesPath, "capture-helper", "capture-helper.exe"),
    join(cwd, "tools", "capture-helper", "target", "release", "capture-helper.exe"),
    join(appPath, "..", "..", "tools", "capture-helper", "target", "release", "capture-helper.exe")
  ];
}

export type GlobalMouseEvent =
  | { event: "middle-click" }
  | { event: "mouse-wheel"; x?: number; y?: number; deltaY?: number }
  | { event: "error"; error?: string };

export function routeGlobalMouseEvent(event: GlobalMouseEvent, onMiddleClick: () => void, onMouseEvent?: (event: GlobalMouseEvent) => void, onDiagnostic?: (message: string) => void): void {
  if (event.event === "middle-click") onMiddleClick();
  else if (event.event === "mouse-wheel") onMouseEvent?.(event);
  else if (event.event === "error") onDiagnostic?.(`MIDDLE_MOUSE_WATCH_ERROR: ${event.error ?? "unknown"}`);
}

export class MiddleMouseShortcutManager {
  private child?: ChildProcess;
  private buffer = "";

  constructor(private readonly executable: string, private readonly onMiddleClick: () => void, private readonly onDiagnostic?: (message: string) => void, private readonly onMouseEvent?: (event: GlobalMouseEvent) => void) {}

  start(): boolean {
    if (this.child || !existsSync(this.executable) || process.platform !== "win32") return false;
    const child = spawn(this.executable, ["--mode", "mouse-watch"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as GlobalMouseEvent & { error?: string };
          routeGlobalMouseEvent(event, this.onMiddleClick, this.onMouseEvent, this.onDiagnostic);
        } catch { /* ignore helper noise */ }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.onDiagnostic?.(`MIDDLE_MOUSE_WATCH_STDERR: ${chunk.trim().slice(0, 240)}`));
    child.on("exit", (code) => { if (this.child === child) this.child = undefined; if (code && code !== 0) this.onDiagnostic?.(`MIDDLE_MOUSE_WATCH_EXIT: ${code}`); });
    child.on("error", (error) => { if (this.child === child) this.child = undefined; this.onDiagnostic?.(`MIDDLE_MOUSE_WATCH_FAILED: ${error.message}`); });
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
  }
}
