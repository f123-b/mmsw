import { describe, expect, it } from "vitest";
import { parseStructuredChatResponse } from "./chat-response";

describe("structured chat responses", () => {
  it("parses cards, sources and confirmation-gated actions", () => {
    const response = parseStructuredChatResponse(JSON.stringify({ text: "还缺量化结果", cards: [{ kind: "gap", title: "项目结果" }], sources: [{ id: "doc-1", label: "FOC 文档" }], actions: [{ type: "add_project_fact", label: "确认添加", payload: { projectId: "p-1" } }] }));
    expect(response.cards?.[0]?.kind).toBe("gap");
    expect(response.sources?.[0]?.label).toBe("FOC 文档");
    expect(response.actions?.[0]).toMatchObject({ type: "add_project_fact", requiresConfirmation: true, status: "pending" });
  });

  it("keeps ordinary markdown as text", () => {
    expect(parseStructuredChatResponse("# 先看项目背景").text).toBe("# 先看项目背景");
  });
});
