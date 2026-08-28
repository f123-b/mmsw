import { ClaimEvidenceValidator, type ClaimEvidenceValidation, type ClaimType } from "../knowledge/answer-validator";
import type { EvidenceSnapshot } from "./evidence-context";

export type ClaimGateDecision = "allow" | "fallback";

export interface ClaimGateInput {
  question: string;
  answer: string;
  evidenceSnapshot?: EvidenceSnapshot;
  evidence?: string[];
  requiresPersonalEvidence?: boolean;
}

export interface ClaimGateResult {
  decision: ClaimGateDecision;
  allowed: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  fallbackAnswer?: string;
  validation: ClaimEvidenceValidation;
  blockedClaims: Array<{ claim: string; type: ClaimType; status: "unsupported" | "conflicting" }>;
}

export const SAFE_GROUNDED_FALLBACK = "这部分在当前已确认的项目资料中没有足够证据，我不能把推测说成实际经历。如果只回答通用方法，我会先复现现象并记录数据，再按信号、时序和任务链路逐层定位，修复后用同一工况回归验证。";

const HIGH_RISK_TYPES = new Set<ClaimType>(["hardware", "metric", "responsibility", "result"]);
const SAFE_DISCLAIMER = /当前.*(?:没有|缺少).*证据|资料.*(?:没有|不足).*证据|不能把推测说成实际经历/;
const PERSONAL_ACTION = /(?:我|我的|我们|项目中).{0,18}(?:负责|主导|实现|设计|带领|参与|做过|使用|采用|解决|优化)/;

function evidenceFrom(input: ClaimGateInput): string[] {
  if (input.evidence) return input.evidence.filter((item) => item.trim());
  const snapshot = input.evidenceSnapshot;
  if (!snapshot) return [];
  return input.requiresPersonalEvidence
    ? [...snapshot.personalMemoryEvidence, ...snapshot.experienceContext]
    : [...snapshot.personalMemoryEvidence, ...snapshot.experienceContext, ...snapshot.projectEvidence, ...snapshot.retrievedKnowledge];
}

/**
 * Final claim boundary for personal/project answers. It reuses the existing
 * deterministic claim matcher, but makes the source boundary explicit: a
 * project code excerpt or global reference cannot prove personal ownership.
 */
export class ClaimGate {
  check(input: ClaimGateInput): ClaimGateResult {
    const answer = input.answer.trim();
    const evidence = evidenceFrom(input);
    const validation = new ClaimEvidenceValidator().validate(answer, evidence);
    const blockedClaims = validation.claims
      .filter((claim) => (claim.status === "unsupported" || claim.status === "conflicting") && HIGH_RISK_TYPES.has(claim.type))
      .map((claim) => ({ claim: claim.claim, type: claim.type, status: claim.status as "unsupported" | "conflicting" }));
    const issues: string[] = [];
    const suggestions: string[] = [];
    if (!answer) {
      issues.push("empty-answer");
      suggestions.push("答案为空，不能提交到面试覆盖层");
    }
    if (input.requiresPersonalEvidence && evidence.length === 0 && PERSONAL_ACTION.test(answer) && !SAFE_DISCLAIMER.test(answer)) {
      issues.push("missing-personal-evidence");
      suggestions.push("资料没有记录这段经历，不能编造；应明确说明证据不足");
    }
    if (input.requiresPersonalEvidence && blockedClaims.length > 0) {
      if (blockedClaims.some((claim) => claim.status === "conflicting")) {
        issues.push("claim-evidence-conflicting");
        suggestions.push("存在与资料冲突的个人事实，只保留已确认版本");
      }
      if (blockedClaims.some((claim) => claim.status === "unsupported")) {
        issues.push("claim-evidence-unsupported");
        suggestions.push("删除或改写没有证据支持的职责、硬件、指标或结果");
      }
    }
    const allowed = issues.length === 0;
    return {
      decision: allowed ? "allow" : "fallback",
      allowed,
      score: allowed ? validation.score : Math.min(validation.score, 0.2),
      issues,
      suggestions,
      ...(allowed ? {} : { fallbackAnswer: SAFE_GROUNDED_FALLBACK }),
      validation,
      blockedClaims
    };
  }

  evaluate(input: ClaimGateInput): ClaimGateResult { return this.check(input); }
}
