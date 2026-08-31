import { describe, expect, it } from "vitest";
import { buildSessionTerminologyContext } from "./dynamic-lexicon-builder";
import { TechnicalTerminologyNormalizer } from "./technical-terminology-normalizer";

describe("technical terminology compatibility rollout", () => {
  const context = buildSessionTerminologyContext({
    jd: "Java 后端并发与网络服务",
    resume: "负责 STM32 与 FOC 电机控制项目",
    project: "使用 MySQL、Redis 和 Docker",
    customTerms: [{ id: "user:lock", canonical: "Lock", aliases: ["lock"], phoneticAliases: [], domains: ["java"], source: "user", priority: 125 }]
  });

  it("builds a routed session lexicon from multiple local sources", () => {
    expect([...context.primaryDomains, ...context.secondaryDomains]).toEqual(expect.arrayContaining(["java"]));
    expect(context.terms.some((term) => term.canonical === "STM32")).toBe(true);
    expect(context.terms.some((term) => term.canonical === "MySQL")).toBe(true);
    expect(context.sourceCounts.user).toBe(1);
  });

  it("applies only high-confidence deterministic corrections", () => {
    const normalizer = new TechnicalTerminologyNormalizer({ context, mode: "high_confidence" });
    const result = normalizer.normalizeTranscript("I two C 和 U A R T 的区别？");
    expect(result.canonicalText).toContain("I2C");
    expect(result.canonicalText).toContain("UART");
    expect(normalizer.normalizeTranscript("哈 fault 怎么定位？").canonicalText).toContain("HardFault");
    expect(normalizer.normalizeTranscript("count down latch 怎么用？").canonicalText).toContain("CountDownLatch");
  });

  it("keeps medium fuzzy matches as candidates and leaves shadow text unchanged", () => {
    const high = new TechnicalTerminologyNormalizer({ context, mode: "high_confidence" }).normalizeTranscript("偶发 leek 怎么定位？");
    expect(high.canonicalText).not.toContain("Lock");
    expect(high.candidates.some((candidate) => ["Lock", "Leak"].includes(candidate.canonical))).toBe(true);

    const shadow = new TechnicalTerminologyNormalizer({ context, mode: "shadow" }).normalizeTranscript("U A R T 怎么调试？");
    expect(shadow.canonicalText).toBe(shadow.normalizedText);
    expect(shadow.mode).toBe("shadow");
  });

  it("stays within the local low-latency budget for short transcripts", () => {
    const normalizer = new TechnicalTerminologyNormalizer({ context, mode: "high_confidence" });
    const durations = Array.from({ length: 30 }, (_, index) => normalizer.normalizeTranscript(`${index % 2 ? "SPI" : "U A R T"} 怎么排查？`).normalizationMs);
    expect(Math.max(...durations)).toBeLessThan(20);
  });
});
