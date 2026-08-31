import { describe, expect, it } from "vitest";
import { userFacingRuntimeDiagnostic } from "./runtime-notices";

describe("user-facing runtime notices", () => {
  it("hides internal queue and request diagnostics", () => {
    expect(userFacingRuntimeDiagnostic("ANSWER_QUEUED: question-252 (1)")).toBeUndefined();
    expect(userFacingRuntimeDiagnostic("PROVIDER_REQUEST_SENT question-252")).toBeUndefined();
  });

  it("keeps actionable failures without leaking internal ids", () => {
    expect(userFacingRuntimeDiagnostic("LLM_FAILED: question-252")).toBe("AI 服务暂时中断，请重试");
    expect(userFacingRuntimeDiagnostic("ASR connection failed; reconnect is still enabled")).toContain("语音识别");
  });
});
