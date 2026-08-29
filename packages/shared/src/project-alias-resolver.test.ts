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
});
