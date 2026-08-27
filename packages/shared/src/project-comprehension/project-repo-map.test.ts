import { describe, expect, it } from "vitest";
import { SourceProjectExplorer } from "./repo-explorer";
import { buildProjectRepoMap } from "./repo-map";

describe("Project Repo Map", () => {
  it("maps entry points, languages, build files, tests and exclusions", () => {
    const explorer = new SourceProjectExplorer([{ id: "repo", kind: "repository", title: "repo", text: "文件：src/main.c\nint main(){}\n\n---\n\n文件：src/control.c\nFOC control\n\n---\n\n文件：CMakeLists.txt\nadd_executable(app src/main.c)\n\n---\n\n文件：tests/control.test.c\npassed\n\n---\n\n文件：vendor/third.c\nprivate" }]);
    const map = buildProjectRepoMap({ projectId: "p", tree: explorer.listTree() });
    expect(map.languages).toContain("C");
    expect(map.entryPoints).toContain("src/main.c");
    expect(map.buildSystems).toContain("CMake");
    expect(map.testFiles).toContain("tests/control.test.c");
    expect(map.files.some((file) => file.path.startsWith("vendor/"))).toBe(false);
  });
});

