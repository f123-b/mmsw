import { describe, expect, it } from "vitest";
import type { ProjectMemoryProject } from "@interview-copilot/shared";
import { mergeProjectCollection, nextProjectIdAfterDelete, type ProjectCollectionRecord } from "./project-collection";

const record = (id: string, name: string, updatedAt = 1): ProjectCollectionRecord => ({ id, name, createdAt: updatedAt, updatedAt });
const memoryProject = (id: string, name: string): ProjectMemoryProject => ({ id, name, profileId: "profile-a", description: `${name} detail`, role: "owner", hardware: [], software: [], technologyStack: [name], sourceIds: [`source-${id}`], confidence: 1 });

describe("project collection selection", () => {
  it("keeps every database project selectable before memory analysis completes", () => {
    const projects = [record("project-a", "A"), record("project-b", "B")];
    const merged = mergeProjectCollection(projects, [memoryProject("project-a", "旧名称 A")]);
    expect(merged.map((project) => project.id)).toEqual(["project-a", "project-b"]);
    expect(merged[0]).toMatchObject({ id: "project-a", name: "A", description: "旧名称 A detail" });
    expect(merged[1]).toMatchObject({ id: "project-b", name: "B", confidence: 0 });
  });

  it("chooses a deterministic remaining project after deletion", () => {
    const projects = [record("project-a", "A", 3), record("project-b", "B", 2), record("project-c", "C", 1)];
    expect(nextProjectIdAfterDelete(projects, "project-b")).toBe("project-a");
    expect(nextProjectIdAfterDelete(projects, "project-a")).toBe("project-b");
    expect(nextProjectIdAfterDelete(projects.slice(0, 1), "project-a")).toBeUndefined();
  });

  it("does not mix memory details between projects with similar names", () => {
    const merged = mergeProjectCollection([record("project-a", "同名项目"), record("project-b", "同名项目")], [memoryProject("project-b", "同名项目")]);
    expect(merged[0]?.sourceIds).toEqual([]);
    expect(merged[1]?.sourceIds).toEqual(["source-project-b"]);
  });
});
