import { describe, expect, it } from "vitest";
import { PcmBackpressureQueue, TranscriptStabilizer } from "./index";

describe("TranscriptStabilizer", () => {
  it("keeps mic and remote channels independent and does not persist partials", () => {
    const stabilizer = new TranscriptStabilizer();
    stabilizer.upsert({ id: "r1", source: "remote", text: "FOC的", startMs: 0, endMs: 300, final: false });
    expect(stabilizer.history("remote")).toHaveLength(0);
    stabilizer.upsert({ id: "r1", source: "remote", text: "FOC 的电流环？", startMs: 0, endMs: 900, final: true });
    stabilizer.upsert({ id: "m1", source: "mic", text: "我会先确认采样时刻", startMs: 1_000, endMs: 1_400, final: true });
    expect(stabilizer.history("remote")[0]?.text).toBe("FOC 的电流环？");
    expect(stabilizer.history("mic")[0]?.text).toContain("采样时刻");
  });

  it("replaces overlapping final revisions instead of duplicating one utterance", () => {
    const stabilizer = new TranscriptStabilizer();
    stabilizer.upsert({ id: "remote-item-final", utteranceId: "item-7", source: "remote", text: "追和栈", startMs: 100, endMs: 800, final: true });
    stabilizer.upsert({ id: "remote-item-final-revision", utteranceId: "item-7", source: "remote", text: "堆和栈的区别是什么？", startMs: 100, endMs: 900, final: true });
    expect(stabilizer.history("remote")).toHaveLength(1);
    expect(stabilizer.history("remote")[0]?.text).toBe("堆和栈的区别是什么？");
  });
});

describe("PcmBackpressureQueue", () => {
  it("drops the oldest packets when the three-second budget is exceeded", () => {
    const queue = new PcmBackpressureQueue(10);
    queue.push(new Uint8Array([1, 2, 3, 4, 5]));
    queue.push(new Uint8Array([6, 7, 8, 9, 10]));
    const stats = queue.push(new Uint8Array([11, 12, 13]));
    expect(stats.droppedPackets).toBe(1);
    expect(Array.from(queue.shift() ?? [])).toEqual([6, 7, 8, 9, 10]);
  });
});
