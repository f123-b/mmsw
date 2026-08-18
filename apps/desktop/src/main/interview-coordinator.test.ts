import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AnswerAgent, ModelRouter, SessionStateMachine, type AnswerProvider } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";

class FakeAudio extends EventEmitter {
  started?: Record<string, unknown>;
  start(options: Record<string, unknown>): void { this.started = options; }
  stop(): void { this.emit("stopped"); }
}

class FakeRealtime extends EventEmitter {
  lastPacket?: Uint8Array;
  connect(): void { this.emit("state", "connected"); }
  disconnect(): void { this.emit("state", "disconnected"); }
  sendAudio(packet: Uint8Array): void { this.lastPacket = packet; }
  sendControl(message: unknown): void { this.emit("control", message); }
}

async function* answerChunks(): AsyncGenerator<string> {
  yield "核心回答";
  yield "。";
}

describe("InterviewCoordinator software E2E", () => {
  it("runs PCM transport, ASR final, aggregation, question, answer and history", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: () => answerChunks() };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const messages: unknown[] = [];
    const questions: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown; event?: unknown }) => {
      if (event.type === "realtime_message") messages.push(event.message);
      if (event.type === "question") questions.push(event.event);
    });

    const interviewId = await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    expect(audio.started?.meterOnly).toBe(false);
    audio.emit("pcm-packet", new Uint8Array(2_560));
    expect(realtime.lastPacket?.byteLength).toBe(2_560);
    realtime.emit("transcript", { source: "remote", final: [] }, { id: "r1", source: "remote", text: "请介绍一下项目", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(questions.some((event) => (event as { type: string }).type === "question_confirmed")).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "answer_start" }),
      expect.objectContaining({ type: "answer_delta", delta: "核心回答" }),
      expect.objectContaining({ type: "answer_end", text: "核心回答。" })
    ]));
    await coordinator.stop();
    expect(coordinator.running).toBe(false);
    expect(interviewId).toMatch(/^interview-/);
    vi.useRealTimers();
  });
});
