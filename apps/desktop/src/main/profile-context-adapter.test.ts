import { describe, expect, it } from "vitest";
import { createProfile } from "@interview-copilot/shared";
import { adaptProfileToInterviewContext } from "./profile-context-adapter";

describe("profile context adapter", () => {
  it("keeps candidate evidence and job target context in separate branches", () => {
    const profile = createProfile({ name: "Candidate", resume: { rawContent: "resume", summary: "candidate summary" }, jobDescription: { rawContent: "jd", summary: "target summary" }, skills: [{ id: "skill-1", name: "TypeScript", description: "typed JS", content: "safe refactors", tags: [] }] });
    const context = adaptProfileToInterviewContext(profile, { id: "target-1", profileId: profile.id, name: "Frontend Engineer", description: "target description", status: "active", requirements: [{ id: "req-1", jobTargetId: "target-1", category: "skill", requirement: "TypeScript", importance: "high", verified: true, createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 1 });

    expect(context.candidate).toMatchObject({ name: "Candidate", resumeSummary: "candidate summary", skills: [{ name: "TypeScript" }] });
    expect(context.candidate).not.toHaveProperty("jobDescription");
    expect(context.target).toMatchObject({ id: "target-1", name: "Frontend Engineer", description: "target description", requirements: [{ requirement: "TypeScript" }] });
  });
});
