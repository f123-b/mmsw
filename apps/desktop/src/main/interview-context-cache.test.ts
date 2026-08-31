import { describe, expect, it } from "vitest";
import { InterviewContextCache } from "./interview-context-cache";

describe("InterviewContextCache", () => {
  it("returns cloned session context and invalidates it on release", () => {
    const cache = new InterviewContextCache();
    const key = { profileId: "profile", projectId: "project", jobTargetId: "job" };
    cache.prepare(key, { profileSummary: "cached profile", projectEvidence: ["cached fact"] });

    const first = cache.get(key);
    expect(first?.contextMode).toBe("fast");
    first?.projectEvidence?.push("caller mutation");
    expect(cache.get(key)?.projectEvidence).toEqual(["cached fact"]);
    expect(cache.getActive()?.profileSummary).toBe("cached profile");

    cache.invalidate(key);
    expect(cache.get(key)).toBeUndefined();
    expect(cache.getActive()).toBeUndefined();
  });
});
