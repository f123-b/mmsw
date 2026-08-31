import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { processHasExited, terminateGracefully, terminateWithTimeout, waitForProcessExit } from "./managed-process";

function fixtureProcess(durationMs = 10_000) {
  return spawn(process.execPath, ["-e", `setTimeout(() => undefined, ${durationMs})`], { windowsHide: true, stdio: "ignore" });
}

function hangingProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; killed: boolean };
  child.pid = 42_424;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals) => {
    child.killed = true;
    if (signal === "SIGKILL") {
      child.exitCode = 137;
      child.emit("exit", 137, null);
      child.emit("close", 137, null);
    }
    return true;
  }) as ChildProcess["kill"];
  return child;
}

describe("managed process lifecycle", () => {
  it("PROCESS_GRACEFUL_EXIT", async () => {
    const child = fixtureProcess();
    const result = await terminateGracefully(child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 });
    expect(result).toEqual({ exited: true, forced: false });
  });

  it("PROCESS_ALREADY_EXITED", async () => {
    const child = fixtureProcess(1);
    expect(await waitForProcessExit(child, 1_000)).toBe(true);
    const result = await terminateWithTimeout(child, { gracefulTimeoutMs: 10, forceTimeoutMs: 10 });
    expect(result).toEqual({ exited: true, forced: false });
  });

  it("PROCESS_TIMEOUT_FORCE_KILL", async () => {
    const child = hangingProcess();
    const forceKill = vi.fn(async () => { child.kill("SIGKILL"); });
    const result = await terminateWithTimeout(child, { platform: "win32", gracefulTimeoutMs: 10, forceTimeoutMs: 500, forceKillProcessTree: forceKill });
    expect(forceKill).toHaveBeenCalledWith(child.pid);
    expect(result).toEqual({ exited: true, forced: true });
  });

  it("PROCESS_KILLED_FLAG_NOT_EQUAL_EXIT", async () => {
    const child = fixtureProcess();
    child.kill();
    expect(child.killed).toBe(true);
    expect(await waitForProcessExit(child, 1_000)).toBe(true);
    expect(processHasExited(child)).toBe(true);
  });

  it("PROCESS_TREE_TERMINATED_ON_WINDOWS", async () => {
    const child = hangingProcess();
    let forceCalled = false;
    const result = await terminateWithTimeout(child, {
      platform: "win32",
      gracefulTimeoutMs: 10,
      forceTimeoutMs: 500,
      forceKillProcessTree: async () => { forceCalled = true; child.kill("SIGKILL"); }
    });
    expect(forceCalled).toBe(true);
    expect(result.exited).toBe(true);
  });
});
