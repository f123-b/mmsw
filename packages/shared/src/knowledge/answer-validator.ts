import { normalizeTechnicalTerms } from "../terminology";
import type { PersonalQuestionAnalysis } from "./retriever";

export interface PersonalAnswerValidation {
  score: number;
  valid: boolean;
  evidenceCoverageScore: number;
  issues: string[];
  suggestions: string[];
  unsupportedTerms: string[];
}

export interface PersonalAnswerValidationInput {
  question: string;
  answer: string;
  analysis: PersonalQuestionAnalysis;
  evidence: string[];
}

const AI_STYLE = /^(首先|其次|最后|综上|总的来说|本文将|可以采用)/;
const TECHNICAL_TOKEN = /STM\d+[A-Z0-9]*|RK\d+|FreeRTOS|RTOS|FOC|SVPWM|DMA|ADC|PWM|CAN|UART|MQTT|Linux|Python|C\+\+|TypeScript|SQLite|ROS2|WebSocket/gi;

export class PersonalAnswerValidator {
  validate(input: PersonalAnswerValidationInput): PersonalAnswerValidation {
    const answer = normalizeTechnicalTerms(input.answer).trim();
    const evidenceText = normalizeTechnicalTerms(input.evidence.join("\n"));
    const issues: string[] = [];
    const suggestions: string[] = [];
    const unsupportedTerms = [...new Set((answer.match(TECHNICAL_TOKEN) ?? []).filter((term) => !new RegExp(term.replace(/[+]/g, "\\+"), "i").test(evidenceText)))];
    const claimTerms = [...new Set([...(answer.match(TECHNICAL_TOKEN) ?? []), ...(answer.match(/\b\d+(?:\.\d+)?\s*(?:ms|us|秒|%|Hz|MHz|kHz|MB|KB|路|个)/gi) ?? [])])];
    const supportedClaims = claimTerms.filter((term) => new RegExp(term.replace(/[+]/g, "\\+"), "i").test(evidenceText)).length;
    const evidenceCoverageScore = claimTerms.length === 0 ? 1 : Number((supportedClaims / claimTerms.length).toFixed(2));
    let score = 1;
    if (input.analysis.requiresPersonalEvidence && !/(我|我的|我们|在项目中)/.test(answer)) { issues.push("not-first-person"); suggestions.push("改成第一人称，说明我在项目中实际做了什么"); score -= 0.2; }
    if (AI_STYLE.test(answer)) { issues.push("ai-style"); suggestions.push("减少‘首先/其次/综上’，改成自然口语"); score -= 0.12; }
    if (input.analysis.requiresPersonalEvidence && input.evidence.length === 0) { issues.push("missing-personal-evidence"); suggestions.push("资料没有记录这段经历，不能编造；应明确说明证据不足"); score -= 0.3; }
    if (unsupportedTerms.length) { issues.push("unsupported-technical-claim"); suggestions.push(`核对未在资料中出现的技术：${unsupportedTerms.join("、")}`); score -= 0.25; }
    if (input.analysis.requiresPersonalEvidence && evidenceCoverageScore < 0.7) { issues.push("QUALITY_UNGROUNDED_CLAIM"); suggestions.push("删除或改写资料中没有证据支持的芯片、协议、工具或指标"); score -= 0.25; }
    if (input.analysis.type === "project") {
      const hasStructure = /(背景|职责|实现|问题|解决|结果|原因)/.test(answer);
      if (!hasStructure) { issues.push("missing-project-structure"); suggestions.push("补充项目背景、个人职责、技术实现和问题解决"); score -= 0.12; }
    }
    const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
    return { score: normalizedScore, evidenceCoverageScore, valid: issues.length === 0, issues, suggestions, unsupportedTerms };
  }
}
