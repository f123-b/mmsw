import { describe, expect, it } from "vitest";
import { buildConversationHistory } from "./chat-context";

describe("Chat multi-turn context", () => {
  it("keeps bounded recent user and assistant messages in order", () => {
    const history = buildConversationHistory([
      { role: "user", content: "帮我分析 FOC 项目", status: "completed" },
      { role: "assistant", content: "第二点是电流环与采样同步", status: "completed" },
      { role: "user", content: "把你刚才第二点详细展开", status: "completed" },
      { role: "assistant", content: "重点是采样时序", status: "streaming" }
    ]);
    expect(history).toContain("用户：帮我分析 FOC 项目");
    expect(history).toContain("助手：第二点是电流环与采样同步");
    expect(history).toContain("用户：把你刚才第二点详细展开");
    expect(history).not.toContain("采样时序");
  });
});
