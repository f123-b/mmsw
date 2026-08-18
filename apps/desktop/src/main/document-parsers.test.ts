import { describe, expect, it } from "vitest";
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
});
