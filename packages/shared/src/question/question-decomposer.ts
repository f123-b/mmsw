import { normalizeTechnicalTerms } from "../terminology";
import { classifyQuestionSemanticFrame, type QuestionSemanticFrame } from "./semantic-frame";

export type QuestionSlotIntent = "fact" | "why" | "how" | "comparison" | "enumeration" | "project" | "company" | "salary";
export type QuestionSlotEvidenceScope = "general" | "personal" | "project";

export interface QuestionSlot {
  index: number;
  question: string;
  intent: QuestionSlotIntent;
  semanticFrame: QuestionSemanticFrame;
  evidenceScope: QuestionSlotEvidenceScope;
  required: boolean;
}

export interface QuestionDecomposition {
  isMultiSlot: boolean;
  slots: QuestionSlot[];
  coverageTarget: number;
  reason: string;
}

function splitQuestion(text: string): string[] {
  const normalized = normalizeTechnicalTerms(text).trim();
  if (!normalized) return [];
  const punctuated = normalized.split(/(?<=[？?])/u).map((part) => part.trim()).filter(Boolean);
  if (punctuated.length > 1) return punctuated;
  const semicolonParts = normalized.split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  return semicolonParts.length > 1 && semicolonParts.some((part) => /什么|多少|为什么|如何|怎么|哪些|是否|吗|呢/.test(part)) ? semicolonParts : [normalized];
}

function intentFor(question: string, frame: QuestionSemanticFrame): QuestionSlotIntent {
  if (frame === "company") return "company";
  if (frame === "salary") return "salary";
  if (frame === "comparison" || frame === "selection_tradeoff") return "comparison";
  if (frame === "enumeration") return "enumeration";
  if (frame === "cause" || /为什么|为何|原因/.test(question)) return "why";
  if (frame === "process" || frame === "implementation" || frame === "troubleshooting" || /怎么|如何|流程|步骤/.test(question)) return "how";
  if (/你|我的|项目|负责|做过|经历|用过/.test(question)) return "project";
  return "fact";
}

function evidenceScopeFor(question: string, frame: QuestionSemanticFrame): QuestionSlotEvidenceScope {
  if (frame === "personal_fact" || /你|我的|项目|负责|做过|经历|用过/.test(question)) return "personal";
  if (frame === "company" || frame === "salary") return "personal";
  return /项目|当前系统|这个方案|实际使用/.test(question) ? "project" : "general";
}

export function decomposeQuestion(text: string): QuestionDecomposition {
  const parts = splitQuestion(text);
  const slots = parts.map((question, index) => {
    const semanticFrame = classifyQuestionSemanticFrame(question);
    return { index: index + 1, question, intent: intentFor(question, semanticFrame), semanticFrame, evidenceScope: evidenceScopeFor(question, semanticFrame), required: true };
  });
  const isMultiSlot = slots.length > 1;
  return { isMultiSlot, slots, coverageTarget: slots.length ? 1 : 0, reason: isMultiSlot ? "multiple-explicit-interrogative-segments" : "single-question" };
}

export function multiSlotPrompt(decomposition: QuestionDecomposition): string {
  if (!decomposition.isMultiSlot) return "";
  return [
    "这是一个多槽位问题，必须按顺序覆盖每个子问题；不要只回答最后一个。",
    ...decomposition.slots.map((slot) => `${slot.index}. [${slot.intent}/${slot.semanticFrame}] ${slot.question}（证据范围：${slot.evidenceScope}）`)
  ].join("\n");
}
