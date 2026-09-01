import type { ActiveProjectState } from "./project-context-state";

export type AntecedentType = "PROJECT" | "MODULE" | "TECHNOLOGY" | "PREVIOUS_ANSWER" | "PREVIOUS_QUESTION" | "CODE" | "SCREENSHOT" | "UNKNOWN";
export type AntecedentRelation = "STANDALONE" | "FOLLOW_UP" | "CLARIFICATION";

export interface AntecedentResolutionInput {
  text: string;
  activeProject?: ActiveProjectState;
  currentModule?: string;
  currentTopic?: string;
  previousQuestion?: string;
  previousAnswer?: string;
  spokenProblem?: string;
}

export interface AntecedentResolution {
  type: AntecedentType;
  value?: string;
  relation: AntecedentRelation;
  confidence: number;
  reason: string;
}

const PROJECT_REFERENCE = /(?:这个项目|该项目|你们项目|你这个项目|项目里|项目中|这个系统|这套系统|这个程序)/iu;
const MODULE_REFERENCE = /(?:这个模块|该模块|应用层|底层|驱动层|业务层|模块里)/iu;
const PREVIOUS_REFERENCE = /(?:刚刚那个|上一问|上一个|前面说的|刚才的)/iu;
const CODE_REFERENCE = /(?:这段代码|代码里|代码中|函数里|函数中)/iu;
const SCREENSHOT_REFERENCE = /(?:截图|图片|屏幕上|题面)/iu;
const QUESTION_REFERENCE = /(?:这个|它|这里|里面|其中|你们|再具体|还有哪些|然后呢)/iu;

/** Resolves pronouns without fabricating an object when no antecedent exists. */
export class AntecedentResolver {
  resolve(input: AntecedentResolutionInput): AntecedentResolution {
    const text = input.text.trim();
    if (SCREENSHOT_REFERENCE.test(text)) return { type: "SCREENSHOT", value: input.spokenProblem, relation: "FOLLOW_UP", confidence: 0.9, reason: "screenshot-reference" };
    if (CODE_REFERENCE.test(text)) return { type: "CODE", value: input.currentTopic, relation: "FOLLOW_UP", confidence: 0.9, reason: "code-reference" };
    if (PROJECT_REFERENCE.test(text)) return { type: "PROJECT", value: input.activeProject?.projectId ?? input.activeProject?.projectName, relation: "FOLLOW_UP", confidence: input.activeProject ? 0.98 : 0.68, reason: input.activeProject ? "active-project-reference" : "project-reference-unresolved" };
    if (MODULE_REFERENCE.test(text)) return { type: "MODULE", value: input.currentModule ?? input.currentTopic, relation: "FOLLOW_UP", confidence: input.currentModule ? 0.96 : 0.72, reason: input.currentModule ? "current-module-reference" : "module-reference-inherited-topic" };
    if (PREVIOUS_REFERENCE.test(text)) return { type: input.previousAnswer ? "PREVIOUS_ANSWER" : "PREVIOUS_QUESTION", value: input.previousAnswer ?? input.previousQuestion, relation: "FOLLOW_UP", confidence: input.previousAnswer || input.previousQuestion ? 0.95 : 0.6, reason: "previous-turn-reference" };
    if (QUESTION_REFERENCE.test(text)) {
      if (input.activeProject) return { type: "PROJECT", value: input.activeProject.projectId ?? input.activeProject.projectName, relation: "FOLLOW_UP", confidence: 0.84, reason: "pronoun-inherits-active-project" };
      if (input.previousAnswer) return { type: "PREVIOUS_ANSWER", value: input.previousAnswer, relation: "FOLLOW_UP", confidence: 0.8, reason: "pronoun-inherits-previous-answer" };
      if (input.previousQuestion) return { type: "PREVIOUS_QUESTION", value: input.previousQuestion, relation: "FOLLOW_UP", confidence: 0.76, reason: "pronoun-inherits-previous-question" };
    }
    return { type: "UNKNOWN", relation: "STANDALONE", confidence: 0.6, reason: "no-antecedent" };
  }
}

export function resolveAntecedent(input: AntecedentResolutionInput): AntecedentResolution {
  return new AntecedentResolver().resolve(input);
}
