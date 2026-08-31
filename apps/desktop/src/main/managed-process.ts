import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type ManagedProcessEventName = "CHILD_PROCESS_TERMINATE_REQUESTED" | "CHILD_PROCESS_EXITED" | "CHILD_PROCESS_FORCE_KILLED";

export interface ManagedProcessOptions {
  platform?: NodeJS.Platform;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  commandTimeoutMs?: number;
  onEvent?: (event: ManagedProcessEventName, fields: Record<string, unknown>) => void;
  forceKillProcessTree?: (pid: number) => Promise<void>;
}

export interface ManagedProcessResult {
  exited: boolean;
  forced: boolean;
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 1_000;
const DEFAULT_FORCE_TIMEOUT_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 1_500;

export function processHasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (processHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(exited || processHasExited(child));
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => finish(true);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref?.();
  });
}

export function terminateGracefully(child: ChildProcess, options: ManagedProcessOptions = {}): Promise<ManagedProcessResult> {
  return terminateWithTimeout(child, options);
}

export async function terminateWithTimeout(child: ChildProcess, options: ManagedProcessOptions = {}): Promise<ManagedProcessResult> {
  if (processHasExited(child)) {
    options.onEvent?.("CHILD_PROCESS_EXITED", { pid: child.pid, alreadyExited: true });
    return { exited: true, forced: false };
  }

  const platform = options.platform ?? process.platform;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  const forceTimeoutMs = options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS;
  options.onEvent?.("CHILD_PROCESS_TERMINATE_REQUESTED", { pid: child.pid, gracefulTimeoutMs });
  try { child.kill(); } catch { /* the exit/close event or timeout determines the final state */ }
  if (await waitForProcessExit(child, gracefulTimeoutMs)) {
    options.onEvent?.("CHILD_PROCESS_EXITED", { pid: child.pid, forced: false });
    return { exited: true, forced: false };
  }

  options.onEvent?.("CHILD_PROCESS_FORCE_KILLED", { pid: child.pid, platform });
  if (child.pid && platform === "win32") {
    try {
      await (options.forceKillProcessTree ?? ((pid: number) => forceKillProcessTree(pid, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)))(child.pid);
    } catch {
      try { child.kill("SIGKILL"); } catch { /* wait below records the unresolved process */ }
    }
  } else {
    try { child.kill("SIGKILL"); } catch { /* wait below records the unresolved process */ }
  }
  const exited = await waitForProcessExit(child, forceTimeoutMs);
  if (exited) options.onEvent?.("CHILD_PROCESS_EXITED", { pid: child.pid, forced: true });
  return { exited, forced: true };
}

export function forceKillProcessTree(pid: number, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: timeoutMs }, (error) => error ? reject(error) : resolve());
  });
}

