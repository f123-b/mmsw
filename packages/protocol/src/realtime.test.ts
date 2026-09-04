import { describe, expect, it } from "vitest";
import { parseRealtimeServerMessage, realtimeServerMessageSchema } from "./index";

describe("realtime protocol", () => {
  it("keeps partial and final ASR messages distinct", () => {
    expect(parseRealtimeServerMessage(JSON.stringify({
      type: "asr_partial",
      segment: { id: "r1", source: "remote", text: "为什么", startMs: 0, endMs: 320, final: false }
    })).type).toBe("asr_partial");
    expect(realtimeServerMessageSchema.parse({
      type: "asr_final",
      segment: { id: "r1", utteranceId: "qwen-item-1", source: "remote", text: "为什么要同步采样？", startMs: 0, endMs: 1_000, final: true, confidence: 0.94 }
    }).type).toBe("asr_final");
  });

  it("rejects an unknown runtime error code", () => {
    expect(() => realtimeServerMessageSchema.parse({
      type: "runtime_error", code: "UNKNOWN", message: "bad"
    })).toThrow();
  });

  it("preserves question-specific errors while accepting older unscoped events", () => {
    const error = { type: "runtime_error", code: "PROJECT_EVIDENCE_REQUIRED", message: "资料不足" };
    expect(realtimeServerMessageSchema.parse(error)).toMatchObject(error);
    expect(realtimeServerMessageSchema.parse({ ...error, questionId: "q25" })).toMatchObject({ questionId: "q25" });
  });

  it("carries question group state and answer relation metadata", () => {
    const answerStart = parseRealtimeServerMessage(JSON.stringify({
      type: "answer_start",
      answerId: "answer-1",
      questionId: "question-1",
      mode: "NORMAL",
      model: "test-model",
      groupId: "group-1",
      relation: "PRIMARY"
    }));
    expect(answerStart.type === "answer_start" ? answerStart.groupId : undefined).toBe("group-1");
    expect(realtimeServerMessageSchema.parse({
      type: "question_group_updated",
      groupId: "group-1",
      title: "C语言 · 指针和数组",
      primaryQuestion: "C语言里，指针和数组有什么区别？",
      items: [{ id: "item-1", questionId: "question-1", text: "C语言里，指针和数组。", type: "TOPIC_FRAGMENT", answerable: false, state: "ignored" }],
      slots: [{ id: "slot-1", text: "C语言里，指针和数组有什么区别？", status: "pending" }],
      updatedAt: 1_000
    })).toMatchObject({ type: "question_group_updated", groupId: "group-1" });
  });
});
