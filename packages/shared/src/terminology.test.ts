import { describe, expect, it } from "vitest";
import { buildDynamicTechnicalLexicon, createTerminologyDictionary, normalizeSkillKey, normalizeTechnicalTerms, normalizeTechnicalTermsWithCorrections, resolveContextualTerminology } from "./terminology";
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

  it("repairs high-confidence interview homophones only with the right context", () => {
    const c = resolveContextualTerminology("C 语言里 study 关键字和 count 关键字有什么作用？", { contextText: "C 语言 关键字" });
    expect(c.text).toContain("static");
    expect(c.text).toContain("const");
    expect(c.corrections.map((item) => item.canonical)).toEqual(expect.arrayContaining(["static", "const"]));
    expect(resolveContextualTerminology("我在 study 计划里统计 count 值").text).toBe("我在 study 计划里统计 count 值");
    expect(resolveContextualTerminology("study 关键字作用是什么？").text).toContain("study");
    expect(resolveContextualTerminology("study 和 count 的含义？").possibleTerms).toEqual(expect.arrayContaining([{ value: "static", score: 0.64 }, { value: "const", score: 0.64 }]));
  });

  it("combines question and context signals for split C++ keyword questions", () => {
    const resolution = resolveContextualTerminology("C++ 里 count 关键字和 static 有什么区别？", { contextText: "C++ 关键字 限定符" });
    expect(resolution.text).toContain("const");
    expect(resolution.corrections.map((item) => item.canonical)).toContain("const");
  });

  it("repairs motor and stack homophones without rewriting unrelated speech", () => {
    expect(resolveContextualTerminology("FOC 里的绝对是怎么计算？", { contextText: "FOC 电机控制 编码器" }).text).toContain("极对数");
    expect(resolveContextualTerminology("这和站怎么分配？", { contextText: "堆栈 内存管理" }).text).toContain("栈");
    expect(resolveContextualTerminology("这和站怎么分配？", { contextText: "项目介绍" }).text).toContain("这和站");
  });

  it("builds scoped dynamic rules from profile/project/question-bank vocabulary", () => {
    const lexicon = buildDynamicTechnicalLexicon({
      profileSkills: [{ name: "STM32G431", aliases: ["stm 32 g 431"] }],
      projectFacts: ["FOC 电流环"],
      projectQa: [{ question: "STM32G431 的 ADC 采样" }]
    });
    const result = normalizeTechnicalTermsWithCorrections("stm 32 g 431 的 ADC 采样", lexicon);
    expect(result.text).toContain("STM32G431");
    expect(result.corrections.at(0)).toMatchObject({ canonical: "STM32G431", source: "profile" });
  });

  it("uses runtime context to repair the real interview terminology cases", () => {
    expect(resolveContextualTerminology("电炉环通常放最高优先级。", { contextText: "FOC 电机控制" }).text).toContain("电流环");
    expect(resolveContextualTerminology("T O S相关的问题", { contextText: "RTOS 任务 FreeRTOS 调度 优先级" }).text).toContain("RTOS");
    expect(resolveContextualTerminology("季度战", { contextText: "自我介绍 求职 熟悉 技术" }).text).toBe("技术栈");
    expect(resolveContextualTerminology("比如针头长度、命令字、序号、CRC。", { contextText: "数据帧格式 协议帧" }).text).toContain("帧头、长度");
    expect(resolveContextualTerminology("Woodloader版本。", { contextText: "固件版本 App 升级 版本管理" }).text).toContain("Bootloader");
    expect(resolveContextualTerminology("详细介绍一下这个看准线", { contextText: "多少根线 怎么接 和 485 对比 总线" }).text).toContain("CAN 总线");
  });
});
