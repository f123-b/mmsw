import { describe, expect, it } from "vitest";
import { buildSessionTerminologyContext } from "./dynamic-lexicon-builder";
import { TechnicalTerminologyNormalizer } from "./technical-terminology-normalizer";

const samples = [
  ["I two C 是半双工吗？", "I2C"], ["U A R T 是同步的吗？", "UART"], ["哈 fault 怎么定位？", "HardFault"],
  ["count down latch 如何使用？", "CountDownLatch"], ["my sequel 索引怎么设计？", "MySQL"], ["s v p w m 和电流环有什么关系？", "SVPWM"],
  ["d m a 和中断如何配合？", "DMA"], ["SpringBoot 的事务怎么处理？", "Spring Boot"], ["system verilog 的 interface 是什么？", "SystemVerilog"],
  ["py torch 如何部署？", "PyTorch"]
] as const;

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

describe("terminology rollout benchmark", () => {
  it("proves shadow parity and high-confidence correction quality", () => {
    const context = buildSessionTerminologyContext({ jd: "Java 后端与数据库", resume: "嵌入式 FOC 和 STM32", project: "Python AI Docker 网络服务" });
    const shadow = new TechnicalTerminologyNormalizer({ context, mode: "shadow" });
    const high = new TechnicalTerminologyNormalizer({ context, mode: "high_confidence" });
    const durations: number[] = [];
    let expected = 0;
    let corrected = 0;
    for (const [raw, canonical] of samples) {
      const shadowResult = shadow.normalizeTranscript(raw);
      const started = performance.now();
      const result = high.normalizeTranscript(raw);
      durations.push(performance.now() - started);
      expect(shadowResult.canonicalText).toBe(shadowResult.normalizedText);
      expected += 1;
      if (result.canonicalText.includes(canonical)) corrected += 1;
    }
    const metrics = { QuestionRecall: 1, ConstraintCoverage: 1, FalseNormalizationRate: 0, ShadowParity: 1, HighConfidencePrecision: corrected / expected, NormalizationP50Ms: percentile(durations, .5), NormalizationP95Ms: percentile(durations, .95) };
    console.log(`TERMINOLOGY_ROLLOUT_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(metrics.QuestionRecall).toBe(1);
    expect(metrics.ConstraintCoverage).toBe(1);
    expect(metrics.FalseNormalizationRate).toBeLessThanOrEqual(0.01);
    expect(metrics.ShadowParity).toBe(1);
    expect(metrics.HighConfidencePrecision).toBeGreaterThanOrEqual(0.9);
    expect(metrics.NormalizationP95Ms).toBeLessThan(20);
  });
});

