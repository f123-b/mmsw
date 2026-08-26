import { describe, expect, it } from "vitest";
import { chatFailureText, classifyChatError, PROJECT_AGENT_TIMEOUT_MS } from "./chat-errors";

describe("project Agent chat errors", () => {
  it("uses a longer project analysis deadline", () => {
    expect(PROJECT_AGENT_TIMEOUT_MS).toBe(120_000);
  });

  it("classifies provider failures into actionable codes", () => {
    expect(classifyChatError(Object.assign(new Error("timed out"), { code: "CHAT_TIMEOUT" }))).toBe("CHAT_TIMEOUT");
    expect(classifyChatError(new Error("Answer provider HTTP 401: invalid key"))).toBe("CHAT_AUTH_FAILED");
    expect(classifyChatError(new Error("Answer provider HTTP 400: model not found"))).toBe("CHAT_MODEL_NOT_FOUND");
    expect(classifyChatError(new Error("fetch failed: ECONNRESET"))).toBe("CHAT_NETWORK_FAILED");
  });

  it("shows the failed model and a recovery path", () => {
    expect(chatFailureText("CHAT_TIMEOUT", "deepseek-v4-flash")).toContain("deepseek-v4-flash");
    expect(chatFailureText("CHAT_TIMEOUT", "deepseek-v4-flash")).toContain("模型设置");
  });
});
