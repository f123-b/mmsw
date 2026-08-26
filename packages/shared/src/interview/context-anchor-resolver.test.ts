import { describe, expect, it } from "vitest";
import { ContextAnchorResolver } from "./context-anchor-resolver";
import type { ContextAnchorSnapshot } from "./context-anchor-store";

function snapshot(): ContextAnchorSnapshot {
  const anchor = { id: "rs-question", text: "RS-485 和 RS-232 的核心差异是什么？", normalizedText: "rs-485 和 rs-232 的核心差异是什么？", topic: "RS-485", entities: ["RS-485", "RS-232"], speechAct: "QUESTION" as const, createdAt: 1_000, expiresAt: 9_000, confidence: 0.96 };
  return { latestAnchor: anchor, lastConfirmedQuestion: anchor, currentTopic: "RS-485", anchors: [anchor] };
}

describe("ContextAnchorResolver topic boundaries", () => {
  it("does not attach a short explicit new subject to the previous technical topic", () => {
    const result = new ContextAnchorResolver().resolve({ text: "什么内存泄漏？", speechAct: "QUESTION", anchors: snapshot() });
    expect(result.canonicalQuestion).toBe("什么内存泄漏？");
    expect(result.anchorUsed).toBeUndefined();
    expect(result.reason).toBe("standalone-complete-question");
  });

  it("keeps a generic usage-scenario question attached to its latest subject", () => {
    const result = new ContextAnchorResolver().resolve({ text: "什么场景下会使用？", speechAct: "FOLLOW_UP", anchors: snapshot() });
    expect(result.anchorUsed?.id).toBe("rs-question");
    expect(result.canonicalQuestion).toContain("RS-485");
  });
});
