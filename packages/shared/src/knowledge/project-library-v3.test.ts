import { describe, expect, it } from "vitest";
import { listUserActions } from "./project-actions";
import { ProjectFactConflictResolver } from "./project-facts";
import { deriveProjectSummary, deriveProjectView } from "./project-view";
import { canonicalProjectFactKey, inferFactCardinality } from "./project-semantics";
import { buildTechnologyTaxonomy } from "./project-taxonomy";
import type { ProjectFact } from "./types";

const fact = (id: string, type: ProjectFact["type"], title: string, content: string, extra: Partial<ProjectFact> = {}): ProjectFact => ({ id, projectId: "p", type, title, content, confidence: 0.9, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: content }], evidenceLevel: "confirmed-document", status: "active", ...extra });

describe("Project Library V3 semantics", () => {
  it("keeps set and narrative values out of automatic conflicts", () => {
    const result = new ProjectFactConflictResolver().resolve([
      fact("architecture-a", "architecture", "系统架构", "控制层 + 驱动层"),
      fact("architecture-b", "architecture", "系统架构", "通信层 + 数据采集"),
      fact("can", "technology", "CAN", "CAN"),
      fact("uart", "technology", "UART", "UART"),
      fact("spi", "technology", "SPI", "SPI"),
      fact("module-a", "module", "Motor Control", "FOC"),
      fact("module-b", "module", "Motor Control", "SVPWM"),
      fact("solution-a", "solution", "解决方案", "调整 PI 参数"),
      fact("solution-b", "solution", "解决方案", "优化 ADC 采样窗口"),
      fact("background-a", "background", "项目背景", "实现 FOC"),
      fact("background-b", "background", "项目背景", "支持三闭环")
    ]);
    expect(result.some((item) => item.conflictStatus === "conflicting")).toBe(false);
    expect(result.filter((item) => item.type === "technology")).toHaveLength(3);
  });

  it("creates one stable group for true single-value conflicts", () => {
    const result = new ProjectFactConflictResolver().resolve([
      fact("f405", "hardware", "MCU", "STM32F405"),
      fact("g431", "hardware", "MCU", "STM32G431"),
      fact("ten", "metric", "电流环频率", "电流环频率 10kHz"),
      fact("twenty", "metric", "电流环频率", "电流环频率 20kHz")
    ]);
    const groups = new Set(result.filter((item) => item.conflictGroupId).map((item) => item.conflictGroupId));
    expect(groups).toEqual(new Set(["conflict:p:mcu.main", "conflict:p:control.current_loop.frequency"]));
    expect(result.filter((item) => item.conflictGroupId === "conflict:p:mcu.main")).toHaveLength(2);
    expect(result.every((item) => item.status === "conflicting")).toBe(true);
  });

  it("detects RTOS and ownership contradictions and counts actions by group", () => {
    const candidates = [
      fact("rtos", "software", "RTOS", "FreeRTOS"),
      fact("bare", "software", "RTOS", "No RTOS"),
      fact("self", "responsibility", "职责", "本人负责 CAN"),
      fact("team", "responsibility", "职责", "CAN 由其他成员负责", { ownership: "team" })
    ];
    const result = new ProjectFactConflictResolver().resolve(candidates);
    expect(result.filter((item) => item.conflictStatus === "conflicting")).toHaveLength(4);
    expect(listUserActions(result)).toHaveLength(2);
    expect(canonicalProjectFactKey(result[0] as ProjectFact)).toBe("rtos.primary");
  });

  it("builds a short clean summary and deduplicated technology taxonomy", () => {
    const facts = [
      fact("bg", "background", "项目背景", "根据代码和仓库文档可以确认：这是不应进入概览的分析输出"),
      fact("bg2", "background", "项目背景", "基于 STM32F405 实现实时 FOC 电机控制系统"),
      fact("goal", "goal", "项目目标", "完成电流、速度和位置闭环控制，并集成通信接口"),
      fact("rtos", "technology", "RTOS", "RTOS"),
      fact("freertos", "technology", "FreeRTOS", "FreeRTOS"),
      fact("stm", "hardware", "STM32", "STM32"),
      fact("stm-specific", "hardware", "STM32F405", "STM32F405"),
      fact("can", "technology", "CAN", "CAN"),
      fact("uart", "technology", "UART", "UART"),
      fact("usb", "technology", "USB CDC", "USB CDC"),
      fact("foc", "technology", "FOC", "FOC"),
      fact("svpwm", "technology", "SVPWM", "SVPWM"),
      fact("pid", "technology", "PID", "PID")
    ];
    const summary = deriveProjectSummary(facts);
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary).not.toMatch(/README|项目根目录|考察点|已知可答|源文件/);
    const taxonomy = buildTechnologyTaxonomy(facts);
    expect(taxonomy.find((group) => group.category === "rtos")?.items).toEqual(["FreeRTOS"]);
    expect(taxonomy.find((group) => group.category === "mcu")?.items).toEqual(["STM32F405"]);
    expect(taxonomy.find((group) => group.category === "communication")?.items).toEqual(expect.arrayContaining(["CAN", "UART", "USB CDC"]));
    expect(taxonomy.find((group) => group.category === "control")?.items).toEqual(expect.arrayContaining(["FOC", "SVPWM", "PID"]));
    expect(inferFactCardinality(facts[0] as ProjectFact)).toBe("narrative");
    const project = deriveProjectView({ id: "p", name: "项目", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: [], confidence: 0 }, facts.map((item) => ({ ...item, evidenceLevel: "confirmed-document", status: "active" })));
    expect(project.description).toContain("STM32F405");
  });
});
