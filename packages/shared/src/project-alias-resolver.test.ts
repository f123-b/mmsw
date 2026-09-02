import { describe, expect, it } from "vitest";
import { ProjectAliasResolver } from "./project-alias-resolver";

describe("ProjectAliasResolver", () => {
  const resolver = new ProjectAliasResolver();
  const projects = [
    { id: "foc-control", name: "FOC 电机控制", aliases: ["电机项目"] },
    { id: "gateway", name: "通信网关", aliases: ["网关项目"] }
  ];

  it("resolves an alias and refuses an ambiguous overlap", () => {
    expect(resolver.resolve("电机项目里的 ADC 采样", projects)).toMatchObject({ projectId: "foc-control", ambiguous: false });
    expect(resolver.resolve("项目里的通信和控制", projects).ambiguous).toBe(true);
  });

  it("prioritizes a spoken project name over description overlap and never reverse-matches filler", () => {
    const candidates = [
      { id: "motor", name: "基于STM32F405的实时FOC电机控制系统", entities: ["DMA", "C"] },
      { id: "esp", name: "基于ESP32的智能物联网控制终端", aliases: ["项目中主要负责什么。嗯。系统架构。FOC。"] }
    ];
    expect(resolver.resolve("你这个FOC项目主要负责什么？", candidates).projectId).toBe("motor");
    expect(resolver.resolve("嗯。", candidates).projectId).toBeUndefined();
    expect(resolver.resolve("的原理是什么？", candidates).projectId).toBeUndefined();
    expect(resolver.resolve("DMA是什么？", candidates).confidence).toBeLessThan(0.78);
  });
});
