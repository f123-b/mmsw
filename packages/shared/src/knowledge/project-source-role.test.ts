import { describe, expect, it } from "vitest";
import { inferProjectSourceRole } from "./project-source-role";

describe("project material source role inference", () => {
  it("maps stable filenames and archives deterministically", () => {
    expect(inferProjectSourceRole("PROJECT_OVERVIEW.md")).toBe("overview");
    expect(inferProjectSourceRole("project-architecture.md")).toBe("architecture");
    expect(inferProjectSourceRole("project-debug.md")).toBe("debug");
    expect(inferProjectSourceRole("project-results.md")).toBe("test");
    expect(inferProjectSourceRole("firmware.zip")).toBe("code");
    expect(inferProjectSourceRole("CAN-datasheet.pdf")).toBe("reference");
  });

  it("uses explicit content headings only when filenames are ambiguous", () => {
    expect(inferProjectSourceRole("notes.md", "# 问题排查\n低速抖动")).toBe("debug");
    expect(inferProjectSourceRole("notes.md", "普通会议记录")).toBe("other");
  });

  it("keeps project question banks out of ordinary material roles", () => {
    expect(inferProjectSourceRole("project-questions.md")).toBe("question_bank");
    expect(inferProjectSourceRole("notes.md", "# 项目题库\n问题：ADC 怎么保证实时性？")).toBe("question_bank");
    expect(inferProjectSourceRole("interview-notes.md")).not.toBe("question_bank");
  });
});
