import { describe, expect, it } from "vitest";
import { ProjectMemoryRetriever } from "./project-memory-retriever";
import type { ProjectFact } from "./types";

const facts: ProjectFact[] = [
  { id: "challenge", projectId: "foc", type: "challenge", title: "低速抖动", content: "低速运行时电流采样时序不稳定，最后通过校准 ADC 触发点解决", confidence: 0.9, verified: true, sourceIds: ["doc-1"] },
  { id: "responsibility", projectId: "foc", type: "responsibility", title: "个人职责", content: "负责 FOC 电流环、DMA 采样和故障定位", confidence: 0.9, verified: true, sourceIds: ["doc-1"] },
  { id: "other", projectId: "gateway", type: "technology", title: "网关技术栈", content: "负责 WebSocket 和 SQLite", confidence: 0.9, verified: true, sourceIds: ["doc-2"] }
];

describe("ProjectMemoryRetriever", () => {
  it("boosts challenge facts for a hardest-problem question", () => {
    const [hit] = new ProjectMemoryRetriever().search("这个项目最大的难点是什么？", facts, { selectedProjectId: "foc", topK: 2 });
    expect(hit?.fact.id).toBe("challenge");
    expect(hit?.typeScore).toBe(1);
    expect(hit?.finalScore).toBeGreaterThanOrEqual(0.35);
    expect(hit?.reason).toContain("fact-type=challenge");
  });

  it("boosts responsibility facts and does not force unrelated projects", () => {
    const [hit] = new ProjectMemoryRetriever().search("你在项目中负责什么？", facts, { selectedProjectId: "foc" });
    expect(hit?.fact.id).toBe("responsibility");
    expect(new ProjectMemoryRetriever().search("完全无关的问题", facts, { selectedProjectId: "missing", minScore: 0.18 })).toHaveLength(0);
  });

  it("uses a semantic vector when one is available", () => {
    const vectorFacts = facts.map((fact, index) => ({ ...fact, embedding: index === 0 ? [1, 0] : [0, 1] }));
    const [hit] = new ProjectMemoryRetriever().search("无词面重合", vectorFacts, { queryEmbedding: [1, 0], minScore: 0.18 });
    expect(hit?.fact.id).toBe("challenge");
    expect(hit?.vectorScore).toBe(1);
  });
});
