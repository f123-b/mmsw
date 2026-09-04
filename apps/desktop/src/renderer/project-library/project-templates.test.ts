import { describe, expect, it } from "vitest";
import { parseQuestionBankText } from "@interview-copilot/shared";
import { PROJECT_QA_TEMPLATE } from "./ProjectQuickStart";

describe("downloadable project templates", () => {
  it("can import the supplied question/answer template through the real parser", () => {
    const entries = parseQuestionBankText(PROJECT_QA_TEMPLATE);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.question).toContain("你负责了哪些部分");
    expect(entries.every(entry => entry.answer?.includes("填写"))).toBe(true);
  });
});
