import { describe, expect, it } from "vitest";
import { sidebarHasProjectOverflow, visibleSidebarProjects } from "./sidebar-model";

const projects = Array.from({ length: 20 }, (_, index) => ({ id: `project-${index}`, name: `项目 ${index}` }));

describe("sidebar project overflow model", () => {
  it("keeps the project-library list complete while limiting other pages", () => {
    const compact = visibleSidebarProjects(projects, false);
    const complete = visibleSidebarProjects(projects, true);
    expect(compact).toHaveLength(6);
    expect(complete).toHaveLength(20);
    expect(sidebarHasProjectOverflow(projects, compact)).toBe(true);
    expect(sidebarHasProjectOverflow(projects, complete)).toBe(false);
  });
});
