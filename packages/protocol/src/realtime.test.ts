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
});
