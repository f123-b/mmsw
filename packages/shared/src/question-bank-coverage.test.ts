import { describe, expect, it } from "vitest";
import { calculateQuestionBankCoverage } from "./question-bank-coverage";

describe("Question Bank coverage", () => {
  it("calculates verified coverage and missing skill areas", () => {
    const result = calculateQuestionBankCoverage({
      skills: [{ id: "s-linux", name: "Linux", points: [{ id: "p-driver", title: "Driver" }, { id: "p-memory", title: "Memory" }] }],
      questions: [{ skillIds: ["s-linux"], coveredPointIds: ["p-driver"], verified: true, answerCards: [{ content: "驱动加载", verified: true }] }],
      now: 100
    });
    expect(result.overallCoverage).toBe(50);
    expect(result.topics[0]?.missingAreas).toEqual(["Memory"]);
    expect(result.missingSkills).toEqual(["Linux"]);
  });
});
