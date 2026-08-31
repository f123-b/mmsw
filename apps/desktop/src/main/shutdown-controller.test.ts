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

  it("SHUTDOWN_STEP_TIMEOUT_CONTINUES", async () => {
    const order: string[] = [];
    const shutdown = new ShutdownController([
      { name: "hung", timeoutMs: 10, run: () => new Promise<void>(() => undefined) },
      { name: "next", run: () => { order.push("next"); } }
    ], { globalTimeoutMs: 100 });
    await shutdown.run();
    expect(order).toEqual(["next"]);
    expect(shutdown.errors.map((entry) => entry.step)).toEqual(["hung"]);
  });

  it("SHUTDOWN_HUNG_CHAT_DOES_NOT_BLOCK_EXIT", async () => {
    const events: string[] = [];
    const shutdown = new ShutdownController([
      { name: "wait-chat", timeoutMs: 10, run: () => new Promise<void>(() => undefined) },
      { name: "close-db", run: () => { events.push("close-db"); } }
    ], { globalTimeoutMs: 100, onEvent: ({ event }) => events.push(event) });
    await shutdown.run();
    expect(events).toContain("SHUTDOWN_STEP_TIMEOUT");
    expect(events).toContain("close-db");
    expect(shutdown.isComplete).toBe(true);
  });

  it("SHUTDOWN_TIMEOUT_RECORDED", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const shutdown = new ShutdownController([{ name: "flush-db", timeoutMs: 10, run: () => new Promise<void>(() => undefined) }], {
      globalTimeoutMs: 100,
      onEvent: (event) => events.push(event)
    });
    await shutdown.run();
    expect(events.find((event) => event.event === "SHUTDOWN_STEP_TIMEOUT")?.fields).toMatchObject({ step: "flush-db", timeoutMs: 10 });
  });

  it("SHUTDOWN_IDEMPOTENT_DURING_TIMEOUT", async () => {
    const order: string[] = [];
    const shutdown = new ShutdownController([
      { name: "hung", timeoutMs: 10, run: () => new Promise<void>(() => undefined) },
      { name: "close-db", run: () => { order.push("close-db"); } }
    ], { globalTimeoutMs: 100 });
    await Promise.all([shutdown.run(), shutdown.run(), shutdown.run()]);
    expect(order).toEqual(["close-db"]);
    expect(shutdown.isComplete).toBe(true);
  });

  it("SHUTDOWN_DATABASE_STILL_CLOSES_AFTER_TIMEOUT", async () => {
    let closed = false;
    const shutdown = new ShutdownController([
      { name: "stop-audio", timeoutMs: 10, run: () => new Promise<void>(() => undefined) },
      { name: "close-db", run: () => { closed = true; } }
    ], { globalTimeoutMs: 100 });
    await shutdown.run();
    expect(closed).toBe(true);
  });

  it("records a global hard timeout when the step budget is exhausted", async () => {
    const events: string[] = [];
    const shutdown = new ShutdownController([{ name: "hung", timeoutMs: 100, run: () => new Promise<void>(() => undefined) }], {
      globalTimeoutMs: 10,
      onEvent: ({ event }) => events.push(event)
    });
    await shutdown.run();
    expect(events).toContain("SHUTDOWN_HARD_TIMEOUT");
    expect(shutdown.isComplete).toBe(true);
  });
});
