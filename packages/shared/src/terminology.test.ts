import { describe, expect, it } from "vitest";
import { normalizeTechnicalTerms, normalizeTechnicalTermsWithCorrections } from "./terminology";
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
});
