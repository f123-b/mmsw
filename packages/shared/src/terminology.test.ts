import { describe, expect, it } from "vitest";
import { normalizeTechnicalTerms } from "./terminology";
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
});
