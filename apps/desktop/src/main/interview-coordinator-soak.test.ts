import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AnswerAgent, ModelRouter, SessionStateMachine, type AnswerProvider } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";
import { SqliteDatabase, SqliteInterviewHistoryRepository } from "./database";

class SoakAudio extends EventEmitter {
  isRunning = false;
  start(): void { this.isRunning = true; }
  stop(): void { this.isRunning = false; }
}

class SoakRealtime extends EventEmitter {
  readonly sentAudio: Uint8Array[] = [];
  reconnects = 0;
  connect(): void { this.emit("state", "connected"); }
  disconnect(): void { this.emit("state", "disconnected"); }
  sendAudio(packet: Uint8Array): void { this.sentAudio.push(packet); }
  sendControl(message: unknown): void { this.emit("control", message); }
  reconnect(): void { this.reconnects += 1; this.emit("state", "reconnecting"); this.emit("state", "connected"); }
  transcript(segment: { id: string; source: "mic" | "remote"; text: string; startMs: number; endMs: number; final: boolean }): void {
    this.emit("transcript", { source: segment.source, final: segment.final ? [segment] : [], ...(segment.final ? {} : { partial: segment }) }, segment);
  }
}

async function flushMicrotasks(count = 16): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe("InterviewCoordinator real pipeline soak", () => {
  it("processes 300 real coordinator questions with revisions, MIC/SYSTEM overlap, reconnects and cancellations", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const database = await SqliteDatabase.open(":memory:");
    const audio = new SoakAudio();
    const realtime = new SoakRealtime();
    const history = new SqliteInterviewHistoryRepository(database);
    let clock = 1_000;
    const blockedQuestions = new Set<number>();
    const provider: AnswerProvider = {
      stream: async function* (request, signal) {
        const question = request.sections.find((section) => section.name === "question")?.content ?? "";
        const match = question.match(/第\s*(\d+)\s*题/);
        const index = Number(match?.[1] ?? -1);
        yield `第 ${index} 题回答`;
        if (blockedQuestions.has(index)) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (!signal?.aborted) yield "完成。";
      }
    };
    const answerAgent = new AnswerAgent({ fast: provider, normal: provider, "low-latency": provider }, new ModelRouter({ fast: "soak-model", normal: "soak-model", "low-latency": "soak-model" }));
    const coordinator = new InterviewCoordinator({
      audio,
      realtime,
      session: new SessionStateMachine(),
      answerAgent,
      history,
      questionSilenceMs: 180,
      contextProvider: () => ({}),
      now: () => clock
    });
    const questionEvents: Array<{ type?: string }> = [];
    const answerMessages: Array<{ type?: string; reason?: string }> = [];
    coordinator.on("event", (event: { type: string; event?: { type?: string }; message?: { type?: string; reason?: string } }) => {
      if (event.type === "question" && event.event) questionEvents.push(event.event);
      if (event.type === "realtime_message" && event.message) answerMessages.push(event.message);
    });

    try {
      const interviewId = await coordinator.start({ profileId: "soak-profile", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "FAST" });
      for (let index = 0; index < 300; index += 1) {
        clock += 3_000;
        const startMs = index * 3_000;
        if (index > 0 && index % 31 === 0) blockedQuestions.add(index);
        if (index % 17 === 0) realtime.transcript({ id: `partial-${index}`, source: "remote", text: `第 ${index} 题怎么`, startMs, endMs: startMs + 400, final: false });
        realtime.transcript({ id: `question-${index}`, source: "remote", text: `第 ${index} 题怎么实现？`, startMs, endMs: startMs + 900, final: true });
        if (index % 29 === 0) realtime.transcript({ id: `question-${index}`, source: "remote", text: `第 ${index} 题具体怎么实现？`, startMs, endMs: startMs + 1_000, final: true });
        if (index % 40 === 0) realtime.transcript({ id: `mic-${index}`, source: "mic", text: "我先确认实现细节。", startMs: startMs + 1_100, endMs: startMs + 1_500, final: true });
        if (index > 0 && index % 100 === 0) realtime.reconnect();
        clock += 500;
        vi.advanceTimersByTime(500);
        await flushMicrotasks(80);
        if (!blockedQuestions.has(index)) {
          clock += 1;
          vi.advanceTimersByTime(1);
          await flushMicrotasks(80);
        }
      }
      clock += 1_000;
      vi.advanceTimersByTime(1_000);
      await flushMicrotasks(500);
      const confirmed = questionEvents.filter((event) => event.type === "question_confirmed" || event.type === "question_superseded");
      const cancellations = answerMessages.filter((message) => message.type === "answer_cancelled");
      const answerEnds = answerMessages.filter((message) => message.type === "answer_end");
      await coordinator.stop();
      const snapshot = history.snapshot(interviewId);
      const metrics = {
        questionCount: snapshot.questions.length,
        confirmedCount: confirmed.length,
        answerCount: snapshot.answers.length,
        answerEndCount: answerEnds.length,
        reconnects: realtime.reconnects,
        cancellations: cancellations.length,
        duplicateQuestions: snapshot.questions.length - new Set(snapshot.questions.map((question) => question.text)).size,
        peakMemoryMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1))
      };
      console.log("COORDINATOR_SOAK_METRICS", JSON.stringify(metrics));
      expect(metrics.questionCount).toBe(300);
      expect(metrics.confirmedCount).toBe(300);
      expect(metrics.answerCount).toBe(300);
      expect(metrics.answerEndCount).toBeGreaterThan(280);
      expect(metrics.reconnects).toBe(2);
      expect(metrics.cancellations).toBeGreaterThan(0);
      expect(metrics.duplicateQuestions).toBe(0);
      expect(unhandledRejections).toEqual([]);
      expect(coordinator.running).toBe(false);
      expect((coordinator as unknown as { finalQuestionQueue?: unknown }).finalQuestionQueue).toBeUndefined();
      expect((coordinator as unknown as { answerController?: unknown }).answerController).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      database.close();
      vi.useRealTimers();
    }
  }, 30_000);
});
