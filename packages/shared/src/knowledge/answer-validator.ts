import { normalizeTechnicalTerms } from "../terminology";
import type { PersonalQuestionAnalysis } from "./retriever";

export interface PersonalAnswerValidation {
  score: number;
  valid: boolean;
  evidenceCoverageScore: number;
  issues: string[];
  suggestions: string[];
  unsupportedTerms: string[];
  claimEvidence: ClaimEvidenceValidation;
}

export interface PersonalAnswerValidationInput {
  question: string;
  answer: string;
  analysis: PersonalQuestionAnalysis;
  evidence: string[];
}

const AI_STYLE = /^(首先|其次|最后|综上|总的来说|本文将|可以采用)/;
const TECHNICAL_TOKEN = /STM\d+[A-Z0-9]*|RK\d+|FreeRTOS|RTOS|FOC|SVPWM|DMA|ADC|PWM|CAN|UART|MQTT|Linux|Python|C\+\+|TypeScript|SQLite|ROS2|WebSocket/gi;

export type ClaimType = "hardware" | "software" | "technology" | "responsibility" | "metric" | "frequency" | "time" | "result" | "problem" | "cause" | "solution" | "architecture";
export type ClaimEvidenceStatus = "supported" | "partial" | "unsupported" | "conflicting";

export interface ClaimEvidenceMatch {
  claim: string;
  type: ClaimType;
  status: ClaimEvidenceStatus;
  matchedEvidence: string[];
}

export interface ClaimEvidenceValidation {
  claims: ClaimEvidenceMatch[];
  unsupportedClaims: ClaimEvidenceMatch[];
  conflictingClaims: ClaimEvidenceMatch[];
  needsRepair: boolean;
  score: number;
}

const HIGH_RISK_CLAIM_TYPES = new Set<ClaimType>(["metric", "hardware", "responsibility", "result"]);
const MEASURED_NUMBER = /(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*(?:ms|us|秒|分钟|小时|天|周|个月|年|%|Hz|MHz|kHz|MB|KB|路|个)?/gi;
const CLAIM_RULES: Array<{ type: ClaimType; pattern: RegExp }> = [
  { type: "responsibility", pattern: /(?:我|我的|我们).{0,12}(?:负责|主导|实现|设计|带领|参与)/ },
  { type: "hardware", pattern: /(?:STM\d+[A-Z0-9]*|RK\d+|MCU|芯片|控制板|驱动板|处理器|传感器)/i },
  { type: "software", pattern: /(?:FreeRTOS|RTOS|Linux|Windows|Python|C\+\+|TypeScript|SQLite|工具链|软件)/i },
  { type: "technology", pattern: /(?:CAN|UART|IIC|I2C|SPI|DMA|ADC|PWM|FOC|SVPWM|MQTT|WebSocket|协议|算法|技术|采用|使用|实现)/i },
  { type: "metric", pattern: /(?:\d+(?:\.\d+)?\s*(?:ms|us|秒|分钟|小时|天|%|Hz|MHz|kHz|MB|KB|路|个)|延迟|耗时|占用率|吞吐量|频率|精度|提升\d|下降\d)/i },
  { type: "frequency", pattern: /(?:每天|每周|每月|每次|频率|周期|定期|几次|次数)/ },
  { type: "time", pattern: /(?:\d+\s*(?:天|周|个月|年|小时|分钟)|期间|之前|之后|上线|迭代|耗时)/ },
  { type: "result", pattern: /(?:结果|最终|提升|降低|下降|增加|减少|达到|稳定|成功|完成|改善)/ },
  { type: "problem", pattern: /(?:问题|故障|困难|异常|抖动|丢帧|卡死|崩溃|超时|缺陷)/ },
  { type: "cause", pattern: /(?:原因|因为|由于|根因|导致)/ },
  { type: "solution", pattern: /(?:解决|修复|排查|改为|通过|方案|措施|优化|重试|降级)/ },
  { type: "architecture", pattern: /(?:架构|模块|链路|分层|组件|系统|状态机|任务|服务)/ }
];

function compact(text: string): string {
  return normalizeTechnicalTerms(text).toLowerCase().replace(/[\s，。！？、,.!?；;:：()（）“”"'‘’]/g, "");
}

function claimTerms(claim: string, type: ClaimType): string[] {
  const technical = claim.match(TECHNICAL_TOKEN) ?? [];
  const numbers = claim.match(MEASURED_NUMBER) ?? [];
  const roleWords = type === "responsibility" ? claim.match(/(?:负责|主导|实现|设计|带领|参与)[^，。；;。]{0,16}/g) ?? [] : [];
  const meaningfulChinese = claim.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...technical, ...numbers, ...roleWords, ...meaningfulChinese].map(compact).filter((term) => term.length >= 2 && !/^(?:项目|我们|我在项目中|这个|使用|采用|实现|结果|问题|原因|解决|说明|主要|进行|完成)$/.test(term)))];
}

function hasConflictingHighRiskClaim(claim: string, type: ClaimType, evidence: string): boolean {
  const normalizedEvidence = compact(evidence);
  if (type === "hardware") {
    const claimChips = claim.match(/(?:STM\d+[A-Z0-9]*|RK\d+)/gi) ?? [];
    const evidenceChips = evidence.match(/(?:STM\d+[A-Z0-9]*|RK\d+)/gi) ?? [];
    return claimChips.length > 0 && evidenceChips.length > 0 && !claimChips.some((chip) => normalizedEvidence.includes(compact(chip)));
  }
  if (type === "metric" || type === "result") {
    const claimNumbers = claim.match(MEASURED_NUMBER) ?? [];
    const evidenceNumbers = evidence.match(MEASURED_NUMBER) ?? [];
    const hasResultContext = /(?:结果|最终|提升|降低|下降|增加|减少|达到|延迟|耗时|占用率)/.test(normalizedEvidence);
    return hasResultContext && claimNumbers.length > 0 && evidenceNumbers.length > 0 && !claimNumbers.some((number) => normalizedEvidence.includes(compact(number)));
  }
  if (type === "responsibility") {
    const claimRole = claim.match(/(?:负责|主导|实现|设计|带领|参与)[^，。；;。]{0,16}/)?.[0];
    const evidenceRoles = evidence.match(/(?:负责|主导|实现|设计|带领|参与)[^，。；;。]{0,16}/g) ?? [];
    return Boolean(claimRole && evidenceRoles.length > 0 && !evidenceRoles.some((role) => compact(role) === compact(claimRole)));
  }
  return false;
}

/** Deterministic claim-to-evidence matching used before a personal answer is shown. */
export class ClaimEvidenceValidator {
  validate(answer: string, evidence: string[]): ClaimEvidenceValidation {
    const source = evidence.filter((item) => item.trim());
    const claims: ClaimEvidenceMatch[] = [];
    for (const sentence of answer.split(/[\n。！？!?；;]+/).map((item) => item.trim()).filter(Boolean)) {
      for (const rule of CLAIM_RULES) {
        if (!rule.pattern.test(sentence)) continue;
        const terms = claimTerms(sentence, rule.type);
        const matchedEvidence = source.filter((item) => {
          const normalizedEvidence = compact(item);
          return terms.some((term) => normalizedEvidence.includes(term));
        });
        const evidenceText = source.join("\n");
        const conflicting = hasConflictingHighRiskClaim(sentence, rule.type, evidenceText);
        const matchedTerms = terms.filter((term) => compact(evidenceText).includes(term)).length;
        const status: ClaimEvidenceStatus = conflicting
          ? "conflicting"
          : terms.length === 0 || matchedTerms === 0
            ? "unsupported"
            : matchedTerms < Math.ceil(terms.length * 0.6)
              ? "partial"
              : "supported";
        claims.push({ claim: sentence, type: rule.type, status, matchedEvidence });
      }
    }
    const unsupportedClaims = claims.filter((claim) => claim.status === "unsupported");
    const conflictingClaims = claims.filter((claim) => claim.status === "conflicting");
    const needsRepair = claims.some((claim) => HIGH_RISK_CLAIM_TYPES.has(claim.type) && (claim.status === "unsupported" || claim.status === "conflicting"));
    const score = claims.length === 0
      ? 1
      : Number((claims.reduce((sum, claim) => sum + (claim.status === "supported" ? 1 : claim.status === "partial" ? 0.5 : 0), 0) / claims.length).toFixed(2));
    return { claims, unsupportedClaims, conflictingClaims, needsRepair, score };
  }
}

export class PersonalAnswerValidator {
  validate(input: PersonalAnswerValidationInput): PersonalAnswerValidation {
    const answer = normalizeTechnicalTerms(input.answer).trim();
    const evidenceText = normalizeTechnicalTerms(input.evidence.join("\n"));
    const issues: string[] = [];
    const suggestions: string[] = [];
    const unsupportedTerms = [...new Set((answer.match(TECHNICAL_TOKEN) ?? []).filter((term) => !new RegExp(term.replace(/[+]/g, "\\+"), "i").test(evidenceText)))];
    const claimEvidence = new ClaimEvidenceValidator().validate(answer, input.evidence);
    const claimTerms = [...new Set([...(answer.match(TECHNICAL_TOKEN) ?? []), ...(answer.match(/\b\d+(?:\.\d+)?\s*(?:ms|us|秒|%|Hz|MHz|kHz|MB|KB|路|个)/gi) ?? [])])];
    const supportedClaims = claimTerms.filter((term) => new RegExp(term.replace(/[+]/g, "\\+"), "i").test(evidenceText)).length;
    const evidenceCoverageScore = claimTerms.length === 0 ? 1 : Number((supportedClaims / claimTerms.length).toFixed(2));
    let score = 1;
    if (input.analysis.requiresPersonalEvidence && !/(我|我的|我们|在项目中)/.test(answer)) { issues.push("not-first-person"); suggestions.push("改成第一人称，说明我在项目中实际做了什么"); score -= 0.2; }
    if (AI_STYLE.test(answer)) { issues.push("ai-style"); suggestions.push("减少‘首先/其次/综上’，改成自然口语"); score -= 0.12; }
    if (input.analysis.requiresPersonalEvidence && input.evidence.length === 0) { issues.push("missing-personal-evidence"); suggestions.push("资料没有记录这段经历，不能编造；应明确说明证据不足"); score -= 0.3; }
    if (unsupportedTerms.length) { issues.push("unsupported-technical-claim"); suggestions.push(`核对未在资料中出现的技术：${unsupportedTerms.join("、")}`); score -= 0.25; }
    if (claimEvidence.unsupportedClaims.length) { issues.push("claim-evidence-unsupported"); suggestions.push("删除或改写没有原始资料支持的个人事实"); score -= 0.18; }
    if (claimEvidence.conflictingClaims.length) { issues.push("claim-evidence-conflicting"); suggestions.push("资料之间或答案与资料存在冲突，保留已证实版本并说明不确定性"); score -= 0.3; }
    if (input.analysis.requiresPersonalEvidence && evidenceCoverageScore < 0.7) { issues.push("QUALITY_UNGROUNDED_CLAIM"); suggestions.push("删除或改写资料中没有证据支持的芯片、协议、工具或指标"); score -= 0.25; }
    if (input.analysis.type === "project") {
      const hasStructure = /(背景|职责|实现|问题|解决|结果|原因)/.test(answer);
      if (!hasStructure) { issues.push("missing-project-structure"); suggestions.push("补充项目背景、个人职责、技术实现和问题解决"); score -= 0.12; }
    }
    const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
    return { score: normalizedScore, evidenceCoverageScore, valid: issues.length === 0, issues, suggestions, unsupportedTerms, claimEvidence };
  }
}
