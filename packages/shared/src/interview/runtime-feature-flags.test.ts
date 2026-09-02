import { describe, expect, it } from "vitest";
import { resolveInterviewFeatureFlags } from "./runtime-feature-flags";

describe("interview runtime modes", () => {
  it("enables every safety gate for accurate interviews", () => {
    expect(resolveInterviewFeatureFlags("ACCURATE_INTERVIEW")).toMatchObject({ understandingV3: true, questionCommitGateV3: true, contextualAsrRepair: true, strictProjectQa: true, answerQualityV2: true, decisionTrace: true });
  });

  it("keeps fast practice compatible and supports explicit overrides", () => {
    expect(resolveInterviewFeatureFlags("FAST_PRACTICE")).toMatchObject({ understandingV3: false, strictProjectQa: false });
    expect(resolveInterviewFeatureFlags("FAST_PRACTICE", { understandingV3: true })).toMatchObject({ understandingV3: true, strictProjectQa: false });
  });
});
