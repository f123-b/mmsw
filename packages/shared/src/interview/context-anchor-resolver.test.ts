import { describe, expect, it } from "vitest";
import { ContextAnchorResolver } from "./context-anchor-resolver";
import { ContextAnchorStore } from "./context-anchor-store";
import type { ContextAnchorSnapshot } from "./context-anchor-store";

function snapshot(): ContextAnchorSnapshot {
  const anchor = { id: "rs-question", text: "RS-485 和 RS-232 的核心差异是什么？", normalizedText: "rs-485 和 rs-232 的核心差异是什么？", topic: "RS-485", entities: ["RS-485", "RS-232"], speechAct: "QUESTION" as const, createdAt: 1_000, expiresAt: 9_000, confidence: 0.96 };
  return { latestAnchor: anchor, lastConfirmedQuestion: anchor, currentTopic: "RS-485", anchors: [anchor] };
}

describe("ContextAnchorResolver topic boundaries", () => {
  it("expires currentTopic and confirmed question with the anchor TTL", () => {
    let now = 1_000;
    const store = new ContextAnchorStore(() => now, 100);
    store.addAnchor({ text: "实时采样与中断", speechAct: "TOPIC_ANCHOR", topic: "实时采样与中断", createdAt: now });
    expect(store.snapshot().currentTopic).toBe("实时采样与中断");
    now = 1_101;
    const expired = store.snapshot();
    expect(expired.currentTopic).toBeUndefined();
    expect(expired.latestAnchor).toBeUndefined();
    expect(expired.lastConfirmedQuestion).toBeUndefined();
  });

  it("does not attach a short explicit new subject to the previous technical topic", () => {
    const result = new ContextAnchorResolver().resolve({ text: "什么内存泄漏？", speechAct: "QUESTION", anchors: snapshot() });
    expect(result.canonicalQuestion).toBe("什么内存泄漏？");
    expect(result.anchorUsed).toBeUndefined();
    expect(result.contextRelation).toBe("standalone");
    expect(result.reason).toBe("standalone-complete-question");
  });

  it("keeps a generic usage-scenario question attached to its latest subject", () => {
    const result = new ContextAnchorResolver().resolve({ text: "什么场景下会使用？", speechAct: "FOLLOW_UP", anchors: snapshot() });
    expect(result.anchorUsed?.id).toBe("rs-question");
    expect(result.canonicalQuestion).toBe("什么场景下会使用？");
    expect(result.inheritedTopic).toBe("RS-485");
    expect(result.contextRelation).toBe("follow_up");
  });

  it.each(["说一下 CAN 总线。", "讲一下 ARM 架构。", "Linux 文件系统有哪些？", "volatile 是什么？", "TCP 和 UDP 有什么区别？"])("keeps explicit subject %s standalone", (text) => {
    const result = new ContextAnchorResolver().resolve({ text, speechAct: "ANSWER_REQUEST", anchors: snapshot() });
    expect(result.canonicalQuestion).toBe(text);
    expect(result.anchorUsed).toBeUndefined();
    expect(result.contextRelation).toBe("standalone");
  });
});
