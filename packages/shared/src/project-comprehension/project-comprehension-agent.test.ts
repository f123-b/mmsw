import { describe, expect, it } from "vitest";
import { ProjectComprehensionAgent } from "./agent";

describe("ProjectComprehensionAgent exploration loop", () => {
  it("starts with mapping, then plans reads and searches within bounds", async () => {
    const events: string[] = [];
    const result = await new ProjectComprehensionAgent({ trace: (event) => events.push(event) }).comprehend({
      projectId: "agent-project", projectName: "Agent Fixture", options: { maxToolCalls: 12, maxFilesRead: 5 },
      sources: [{ id: "repo", kind: "repository", title: "repo", text: "文件：src/main.c\nint main(){ control(); }\n\n---\n\n文件：src/control.c\nFOC current loop PWM ADC DMA\n\n---\n\n文件：README.md\n项目用于实时控制。" }]
    });
    expect(events[0]).toBe("PROJECT_COMPREHENSION_STARTED");
    expect(events.indexOf("PROJECT_REPO_MAPPED")).toBeGreaterThan(-1);
    expect(events.indexOf("PROJECT_PLAN_CREATED")).toBeGreaterThan(events.indexOf("PROJECT_REPO_MAPPED"));
    expect(events).toContain("PROJECT_TOOL_CALL");
    expect(result.understanding.trace.toolCalls).toBeLessThanOrEqual(12);
  });
});

