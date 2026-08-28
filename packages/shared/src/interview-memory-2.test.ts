import { describe, expect, it } from "vitest";
import { InterviewMemory2 } from "./interview-memory";

describe("InterviewMemory 2.0", () => {
  it("keeps group and relation metadata across question and answer entries", () => {
    const memory = new InterviewMemory2(4, 8);
    memory.recordQuestion("为什么使用 DMA？", { questionId: "q1", groupId: "g1", relationType: "NEW_TOPIC", createdAt: 1_000 });
    memory.recordAnswer("DMA 可以减少 CPU 搬运。", { questionId: "q1", groupId: "g1", createdAt: 1_100 });
    memory.recordObservation("面试官强调采样时序", { questionId: "q1", groupId: "g1", createdAt: 1_200 });

    const snapshot = memory.snapshot();
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.activeGroupId).toBe("g1");
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "question", questionId: "q1", groupId: "g1" }),
      expect.objectContaining({ kind: "answer", questionId: "q1", groupId: "g1" }),
      expect.objectContaining({ kind: "observation", questionId: "q1", groupId: "g1" })
    ]));
  });

  it("keeps memory entries bounded while retaining recent questions", () => {
    const memory = new InterviewMemory2(3, 6);
    for (let index = 0; index < 10; index += 1) memory.recordQuestion(`问题 ${index}`, { questionId: `q${index}`, createdAt: index });
    expect(memory.snapshot().turns).toHaveLength(3);
    expect(memory.snapshot().entries?.length).toBeLessThanOrEqual(6);
    expect(memory.snapshot().entries?.at(-1)?.questionId).toBe("q9");
  });
});
