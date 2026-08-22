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

  it("keeps punctuation-terminated ASR fragments together when the next fragment continues the prompt", () => {
    const aggregator = new TranscriptAggregator();
    expect(aggregator.push({ id: "r1", source: "remote", text: "请解释 volatile。", startMs: 0, endMs: 900, final: true })?.text).toBe("请解释 volatile。");
    expect(aggregator.push({ id: "r2", source: "remote", text: "关键字的作用。", startMs: 900, endMs: 1_600, final: true })?.text).toBe("请解释 volatile。 关键字的作用。");
    expect(aggregator.push({ id: "r3", source: "remote", text: "以及常见误区，十五秒。", startMs: 1_600, endMs: 2_300, final: true })?.text).toBe("请解释 volatile。 关键字的作用。 以及常见误区，十五秒。");
  });

  it("keeps acknowledgements and repair questions separate from the previous prompt", () => {
    const aggregator = new TranscriptAggregator();
    expect(aggregator.push({ id: "r1", source: "remote", text: "你会怎么排查？", startMs: 0, endMs: 900, final: true })?.text).toBe("你会怎么排查？");
    expect(aggregator.push({ id: "r2", source: "remote", text: "那。", startMs: 1_000, endMs: 1_200, final: true })?.text).toBe("那。");
    expect(aggregator.push({ id: "r3", source: "remote", text: "你觉得呢？", startMs: 1_300, endMs: 1_600, final: true })?.text).toBe("你觉得呢？");
    expect(aggregator.push({ id: "r4", source: "remote", text: "怎么回答？", startMs: 1_700, endMs: 2_000, final: true })?.text).toBe("怎么回答？");
    expect(aggregator.push({ id: "r5", source: "remote", text: "嗯。", startMs: 2_100, endMs: 2_300, final: true })?.text).toBe("嗯。");
  });

  it("does not carry a remote prompt across a candidate answer", () => {
    const aggregator = new TranscriptAggregator();
    aggregator.push({ id: "r1", source: "remote", text: "你准备怎么开始补这块？", startMs: 0, endMs: 900, final: true });
    aggregator.push({ id: "m1", source: "mic", text: "我会先梳理基础。", startMs: 900, endMs: 1_600, final: true });
    // The coordinator performs this source-boundary flush.
    aggregator.flush("remote");
    expect(aggregator.push({ id: "r2", source: "remote", text: "好，那回到你的项目。", startMs: 1_600, endMs: 2_300, final: true })?.text).toBe("好，那回到你的项目。");
  });

  it("keeps a multi-fragment interview question complete even when ASR inserts punctuation", () => {
    const aggregator = new TranscriptAggregator();
    aggregator.push({ id: "r1", source: "remote", text: "行，下一个，说说你遇到过最难定位的一个问题，比如。", startMs: 0, endMs: 1_000, final: true });
    aggregator.push({ id: "r2", source: "remote", text: "急速抖动。", startMs: 1_020, endMs: 1_300, final: true });
    aggregator.push({ id: "r3", source: "remote", text: "当时你怎么一步步排查的？关键转折点是什么？", startMs: 1_320, endMs: 2_000, final: true });
    aggregator.push({ id: "r4", source: "remote", text: "最后。", startMs: 2_020, endMs: 2_160, final: true });
    aggregator.push({ id: "r5", source: "remote", text: "怎么验证？", startMs: 2_180, endMs: 2_400, final: true });
    const text = aggregator.flush("remote")[0]?.text ?? "";
    expect(text).toContain("最难定位的一个问题");
    expect(text).toContain("急速抖动");
    expect(text).toContain("一步步排查");
    expect(text).toContain("最后");
    expect(text).toContain("怎么验证");
  });

  it("replaces a revised final segment instead of duplicating it", () => {
    const aggregator = new TranscriptAggregator();
    aggregator.push({ id: "same-segment", source: "remote", text: "IIC 通讯偶发失败", startMs: 0, endMs: 500, final: true });
    aggregator.push({ id: "same-segment", source: "remote", text: "IIC 通讯偶发读不到数据", startMs: 0, endMs: 650, final: true });
    expect(aggregator.flush("remote")[0]?.text).toBe("IIC 通讯偶发读不到数据");
  });
});
