import { describe, expect, it } from "vitest";
import { createTerminologyDictionary, normalizeSkillKey, normalizeTechnicalTerms, normalizeTechnicalTermsWithCorrections } from "./terminology";
import { QuestionDetector2 } from "./question-detector-2";

describe("technical terminology normalization", () => {
  it("normalizes common ASR variants of IIC before question detection", async () => {
    expect(normalizeTechnicalTerms("iPhonec 总线的时序")).toBe("IIC 总线的时序");
    const result = await new QuestionDetector2().analyze("iPhonec 总线为什么需要上拉电阻？");
    expect(result.normalizedQuestion).toContain("IIC");
    expect(result.isQuestion).toBe(true);
  });

  it("keeps technical acronyms readable when ASR inserts spaces", () => {
    expect(normalizeTechnicalTerms("f o c 里用 d m a 和 s p i")).toBe("FOC 里用 DMA 和 SPI");
  });

  it("corrects embedded architecture, RTOS, interrupt and memory terms locally", () => {
    const result = normalizeTechnicalTermsWithCorrections("追和栈、p e n d s v、free rtos 任务、n v i c、m s p、c a n f d、堆溢出");
    expect(result.text).toContain("堆和栈");
    expect(result.text).toContain("PendSV");
    expect(result.text).toContain("FreeRTOS 任务");
    expect(result.text).toContain("NVIC");
    expect(result.text).toContain("MSP");
    expect(result.text).toContain("CAN FD");
    expect(result.text).toContain("堆溢出");
    expect(result.corrections.length).toBeGreaterThan(3);
  });

  it("recovers CAN homophones only in CAN-specific contexts", () => {
    expect(normalizeTechnicalTerms("看总线的仲裁机制是什么？")).toContain("CAN总线");
    expect(normalizeTechnicalTerms("砍 FD 报文长度是多少？")).toContain("CAN FD");
    expect(normalizeTechnicalTerms("看一下这个函数")).toBe("看一下这个函数");
  });

  it("does not rewrite ordinary words that contain acronym spellings", () => {
    expect(normalizeTechnicalTerms("candidate focus DMA 项目")) .toBe("candidate focus DMA 项目");
  });

  it("supports scoped project vocabulary and records only term-level corrections", () => {
    const dictionary = createTerminologyDictionary([{ canonical: "STM32G431", pattern: /stm\s*32\s*g\s*431/gi, context: /FOC|电机/i, priority: 20 }]);
    const result = normalizeTechnicalTermsWithCorrections("FOC 项目使用 stm 32 g 431", dictionary.rules);
    expect(result.text).toContain("STM32G431");
    expect(result.corrections.at(-1)).toMatchObject({ canonical: "STM32G431", source: "project" });
    expect(result.corrections.every((correction) => correction.raw.length < 32)).toBe(true);
  });

  it("normalizes only true Profile skill aliases", () => {
    expect(normalizeSkillKey("STM32F405")).toBe("stm32");
    expect(normalizeSkillKey("STM32G431")).toBe("stm32");
    expect(normalizeSkillKey("FreeRTOS")).toBe("rtos");
    expect(normalizeSkillKey("CXX")).toBe("cpp");
    expect(normalizeSkillKey("FDCAN")).toBe("can");
    expect(normalizeSkillKey("IIC")).toBe("i2c");
    expect(normalizeSkillKey("FOC")).toBe("foc");
    expect(normalizeSkillKey("PID")).toBe("pid");
  });
});
