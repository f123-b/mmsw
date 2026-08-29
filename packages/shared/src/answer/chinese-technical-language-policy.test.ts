import { describe, expect, it } from "vitest";
import { applyChineseTechnicalLanguagePolicy } from "./chinese-technical-language-policy";

describe("Chinese technical language policy", () => {
  it("expands the first technical abbreviation and preserves code blocks", () => {
    const result = applyChineseTechnicalLanguagePolicy("CAN 和 DMA 协同工作。\n```c\nvolatile CAN_REG;\n```\n后续再提 CAN。");
    expect(result).toContain("CAN（控制器局域网）");
    expect(result).toContain("DMA（直接存储器访问）");
    expect(result).toContain("volatile CAN_REG;");
    expect(result).not.toContain("volatile（易变关键字） CAN_REG");
  });
});
