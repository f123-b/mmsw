import { describe, expect, it } from "vitest";
import { ShutdownController, type ShutdownStep } from "./shutdown-controller";

function controller(order: string[], overrides: Partial<Record<string, () => void | Promise<void>>> = {}): ShutdownController {
  const names = ["shortcuts", "abort", "stop-interview", "audio", "realtime", "flush-history", "close-db", "overlay", "windows"];
  const steps: ShutdownStep[] = names.map((name) => ({ name, run: overrides[name] ?? (() => { order.push(name); }) }));
  return new ShutdownController(steps);
}

describe("ShutdownController", () => {
  it("SHUTDOWN_RUNNING_INTERVIEW", async () => {
    const order: string[] = [];
    await controller(order).run();
    expect(order).toContain("stop-interview");
  });

  it("SHUTDOWN_FLUSHES_HISTORY", async () => {
    const order: string[] = [];
    await controller(order, { "stop-interview": () => { order.push("history-ended"); }, "flush-history": () => { order.push("history-flushed"); } }).run();
    expect(order.indexOf("history-ended")).toBeLessThan(order.indexOf("history-flushed"));
  });

  it("SHUTDOWN_PARTIAL_ANSWER_PERSISTED", async () => {
    let partial = "";
    await controller([], { "stop-interview": () => { partial = "partial answer"; }, "flush-history": () => { if (!partial) throw new Error("partial answer lost"); } }).run();
    expect(partial).toBe("partial answer");
  });

  it("SHUTDOWN_DATABASE_CLOSE_AFTER_INTERVIEW", async () => {
    const order: string[] = [];
    await controller(order).run();
    expect(order.indexOf("stop-interview")).toBeLessThan(order.indexOf("close-db"));
  });

  it("SHUTDOWN_IDEMPOTENT", async () => {
    const order: string[] = [];
    const shutdown = controller(order);
    await Promise.all([shutdown.run(), shutdown.run(), shutdown.run()]);
    expect(order.filter((step) => step === "stop-interview")).toHaveLength(1);
    expect(shutdown.isComplete).toBe(true);
  });

  it("SHUTDOWN_FINALIZE_FAILURE_STILL_CLOSES_DB", async () => {
    const order: string[] = [];
    const shutdown = new ShutdownController([
      { name: "finalize", run: () => { order.push("finalize"); throw new Error("finalize failed"); } },
      { name: "flush", run: () => { order.push("flush"); } },
      { name: "close-db", run: () => { order.push("close-db"); } }
    ]);
    await shutdown.run();
    expect(order).toEqual(["finalize", "flush", "close-db"]);
    expect(shutdown.errors).toHaveLength(1);
  });
});
