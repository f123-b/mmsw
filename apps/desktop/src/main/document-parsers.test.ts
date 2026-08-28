import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parseDocument } from "./document-parsers";

describe("document parsers", () => {
  it("parses markdown and preserves section metadata", async () => {
    const document = await parseDocument({ documentId: "doc-1", filename: "resume.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("# 项目\n实时音频\n## 结果\n延迟降低") });
    expect(document.text).toContain("实时音频");
    expect(document.sections).toEqual(["项目", "结果"]);
    expect(document.sha256).toHaveLength(64);
  });

  it("parses HTML without script content", async () => {
    const document = await parseDocument({ documentId: "doc-2", filename: "jd.html", mimeType: "text/html", bytes: new TextEncoder().encode("<h1>职位</h1><script>secret()</script><p>嵌入式开发</p>") });
    expect(document.text).toContain("职位");
    expect(document.text).toContain("嵌入式开发");
    expect(document.text).not.toContain("secret");
  });

  it("imports a GitHub-style source archive and keeps persisted file boundaries", async () => {
    const zip = new JSZip();
    zip.file("foc2-codex-foc-studio-submit-main/README.md", "FOC motor controller");
    zip.file("foc2-codex-foc-studio-submit-main/src/controller.c", "void current_loop(void) {}");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const document = await parseDocument({ documentId: "repo-1", filename: "foc2-codex-foc-studio-submit.zip", mimeType: "application/x-zip", bytes: bytes.buffer });
    expect(document.text).not.toContain("void current_loop");
    expect(document.repositoryManifest).toMatchObject({ rootName: "foc2-codex-foc-studio-submit-main", eligibleFileCount: 2 });
    expect(document.repositoryFiles?.map((file) => file.path)).toEqual(["README.md", "src/controller.c"]);
    expect(document.repositoryFiles?.find((file) => file.path === "src/controller.c")?.text).toContain("void current_loop");
    expect(document.sections).toContain("src/controller.c");
  });

  it("falls back to ZIP signature when Electron sends an unknown MIME or serialized bytes", async () => {
    const zip = new JSZip();
    zip.file("README", "repository readme");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const serialized = Object.fromEntries(Array.from(bytes, (value, index) => [String(index), value]));
    const document = await parseDocument({ documentId: "repo-2", filename: "download", mimeType: "application/x-zip", bytes: serialized });
    expect(document.mimeType).toBe("application/zip");
    expect(document.repositoryFiles?.[0]?.text).toContain("repository readme");
  });
});
