import { describe, expect, it } from "vitest";
import { normalizeProfileBuilderArtifact } from "./normalizer";

describe("Profile Builder artifact normalizer", () => {
  it("returns a safe complete shape for missing fields", () => {
    const artifact = normalizeProfileBuilderArtifact({ profileId: "p-1" });
    expect(artifact).toMatchObject({ profileId: "p-1", status: "partial", skillGraph: { nodes: [], edges: [] }, projectGraph: { nodes: [], edges: [] }, answerMaterials: [], faqs: [], warnings: [] });
  });

  it("converts invalid JSON into a visible error artifact instead of throwing", () => {
    const artifact = normalizeProfileBuilderArtifact("not-json", { profileId: "p-1" });
    expect(artifact.status).toBe("error");
    expect(artifact.error).toBeTruthy();
    expect(artifact.projectGraph.nodes).toEqual([]);
  });
});
