import { describe, expect, it } from "vitest";
import { TranscriptAggregator } from "./index";

describe("TranscriptAggregator", () => {
  it("combines continuous remote final segments into one utterance", () => {
    const aggregator = new TranscriptAggregator();
    expect(aggregator.push({ id: "r1", source: "remote", text: "请介绍", startMs: 0, endMs: 400, final: true })?.text).toBe("请介绍");
    expect(aggregator.push({ id: "r2", source: "remote", text: "一下你的项目", startMs: 450, endMs: 900, final: true })?.text).toBe("请介绍 一下你的项目");
    expect(aggregator.push({ id: "r3", source: "remote", text: "？", startMs: 950, endMs: 1_000, final: true })?.segmentIds).toEqual(["r1", "r2", "r3"]);
    expect(aggregator.flush("remote")[0]?.text).toBe("请介绍 一下你的项目？");
  });

  it("keeps mic and remote utterances independent", () => {
    const aggregator = new TranscriptAggregator();
    aggregator.push({ id: "m1", source: "mic", text: "我会先确认", startMs: 0, endMs: 300, final: true });
    aggregator.push({ id: "r1", source: "remote", text: "为什么这样设计？", startMs: 0, endMs: 500, final: true });
    expect(aggregator.flush("mic")[0]?.source).toBe("mic");
    expect(aggregator.flush("remote")[0]?.source).toBe("remote");
  });
});
