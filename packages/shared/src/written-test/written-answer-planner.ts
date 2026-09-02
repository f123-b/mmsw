import { createWrittenAnswerPlan, type WrittenAnswerPlan } from "./written-answer-plan";
import type { WrittenProblemFrame } from "./written-test-types";

export class WrittenAnswerPlanner {
  plan(problem: WrittenProblemFrame): WrittenAnswerPlan { return createWrittenAnswerPlan(problem); }
}

