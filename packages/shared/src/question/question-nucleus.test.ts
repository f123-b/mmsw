import { describe, expect, it } from "vitest";
import { analyzeQuestionNucleus } from "./question-nucleus";

describe("QuestionNucleusAnalyzer", () => {
  it("does not turn a project anchor into a personal-fact request", () => {
    expect(analyzeQuestionNucleus("你简历里做过 FOC，FOC 原理是什么？")).toMatchObject({ intent: "technical", nucleus: "FOC 原理是什么" });
  });

  it("keeps an actual project implementation nucleus", () => {
    expect(analyzeQuestionNucleus("你这个 FOC 项目里 ADC 怎么保证实时性？").intent).toBe("project_implementation");
  });
});
