import { describe, expect, it } from "vitest";
import { LocalGitRepositoryAdapter } from "./repository-adapter";
import { SourceProjectExplorer } from "./repo-explorer";

describe("Local Git repository adapter", () => {
  it("parses bounded history and diffs through an argv runner", () => {
    const calls: string[][] = [];
    const adapter = new LocalGitRepositoryAdapter(
      new SourceProjectExplorer([{ id: "repo", kind: "repository", title: "repo", text: "文件：src/main.c\nint main(){}" }]),
      "C:/trusted/repo",
      { run: (_root, args) => { calls.push(args); if (args[0] === "log") return { status: 0, stdout: "abc1234\t2026-08-27\tchange PWM from 32 kHz to 20 kHz\nsrc/main.c\n\n" }; if (args[0] === "diff") return { status: 0, stdout: "M\tsrc/main.c\n" }; return { status: 0, stdout: "abc1234\t2026-08-27\tcommit" }; } },
    );
    expect(adapter.getHistory({ limit: 1 })[0]).toEqual(expect.objectContaining({ hash: "abc1234", changedPaths: ["src/main.c"] }));
    expect(adapter.getDiff("abc1234")).toEqual([{ path: "src/main.c", summary: "M src/main.c" }]);
    expect(() => adapter.getHistory({ path: "../secret" })).toThrow("PROJECT_REPOSITORY_PATH_OUTSIDE_ROOT");
    expect(calls[0]).toContain("log");
  });
});
