import {
  ClaimEvidenceValidator,
  HIGH_RISK_CLAIM_TYPES,
  type ClaimEvidenceMatch,
  type ClaimEvidenceValidation,
  type ClaimType
} from "../knowledge/answer-validator";
import type { AnswerIntent } from "./answer-intent";
import type { EvidenceSnapshot } from "./evidence-context";
import { PersonalPastActionDetector } from "../knowledge/personal-past-action-detector";

export type ClaimGateDecision = "allow" | "rewrite" | "partial" | "abstain";

export interface ClaimGateInput {
  question: string;
  answer: string;
  evidenceSnapshot?: EvidenceSnapshot;
  /** Legacy direct evidence input retained for integrations outside AnswerAgent. */
  evidence?: string[];
  intent?: AnswerIntent;
  /** Legacy flag; claim-level decisions no longer turn every failure into a whole-answer fallback. */
  requiresPersonalEvidence?: boolean;
}

export interface BlockedClaim {
  claim: string;
  type: ClaimType;
  status: "unsupported" | "partial" | "conflicting";
  provenance: ClaimEvidenceMatch["provenance"];
  risk: ClaimEvidenceMatch["risk"];
}

export interface ClaimGateResult {
  decision: ClaimGateDecision;
  /** True when a useful original or rewritten answer may be shown. */
  allowed: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  rewrittenAnswer?: string;
  fallbackAnswer?: string;
  validation: ClaimEvidenceValidation;
  blockedClaims: BlockedClaim[];
  unsupportedPastPersonalActionCount: number;
}

/** Kept for callers that imported the Phase 4 constant. */
export const SAFE_GROUNDED_FALLBACK = "具体个人事实当前没有被确认，我不会把项目事实说成个人经历；如果只回答通用方法，可以先说明原理、排查步骤和验证方式。";
export const SAFE_PERSONAL_IDENTITY_ABSTAIN = "目前资料里没有确认这段个人经历，我不能编造比赛、奖项、论文、专利、学校、公司或职位信息。";

const PERSONAL_CLAIM_TYPES = new Set<ClaimType>(["personal_identity", "responsibility", "metric", "result"]);
const PERSONAL_ATTRIBUTION = /(?:我|我的|我们|本人|在项目中|曾经|实际|做过|使用过|采用过)/;
const MEASURED_VALUE = /(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*(?:ms|us|秒|分钟|小时|天|周|个月|年|%|Hz|MHz|kHz|MB|KB|路|个)?/gi;
const RESULT_WORD = /准确率|召回率|延迟|耗时|吞吐量|占用率|频率|精度|提升|降低|下降|增加|减少|达到|稳定|完成|解决|结果|成果/;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function snapshotStatements(snapshot?: EvidenceSnapshot): string[] {
  return [...(snapshot?.sessionEvidence ?? []), ...(snapshot?.candidateStatements ?? [])].map((item) => item.text);
}

function personalEvidence(input: ClaimGateInput): string[] {
  const snapshot = input.evidenceSnapshot;
  return dedupe([
    ...(input.evidence ?? []),
    ...snapshotStatements(snapshot),
    ...(snapshot?.personalMemoryEvidence ?? []),
    ...(snapshot?.experienceContext ?? []),
    ...(snapshot?.verifiedResumeEvidence ?? []),
    ...(snapshot?.verifiedPersonalProjectFacts ?? []),
    ...(snapshot?.projectQaEvidence ?? [])
  ]);
}

function technicalEvidence(input: ClaimGateInput, personal: string[]): string[] {
  const snapshot = input.evidenceSnapshot;
  return dedupe([
    ...personal,
    ...(snapshot?.projectEvidence ?? []),
    ...(snapshot?.retrievedKnowledge ?? [])
  ]);
}

function findClaim(validation: ClaimEvidenceValidation, target: ClaimEvidenceMatch): ClaimEvidenceMatch {
  return validation.claims.find((claim) => claim.type === target.type && claim.claim === target.claim) ?? target;
}

function claimStatus(target: ClaimEvidenceMatch, personalValidation: ClaimEvidenceValidation, technicalValidation: ClaimEvidenceValidation, allValidation: ClaimEvidenceValidation): ClaimEvidenceMatch {
  if (PERSONAL_CLAIM_TYPES.has(target.type)) return findClaim(personalValidation, target);
  if (target.type === "hardware" && PERSONAL_ATTRIBUTION.test(target.claim)) return findClaim(personalValidation, target);
  return findClaim(allValidation, target);
}

function requiresPersonalValidation(claim: ClaimEvidenceMatch, input: ClaimGateInput): boolean {
  if (claim.type === "personal_identity" || claim.type === "responsibility") return true;
  if (claim.type === "metric") return PERSONAL_ATTRIBUTION.test(claim.claim) || Boolean(input.intent?.requiresPersonalMetric) || input.requiresPersonalEvidence === true;
  if (claim.type === "result") return PERSONAL_ATTRIBUTION.test(claim.claim) || Boolean(input.intent?.requiresPersonalResult) || input.requiresPersonalEvidence === true;
  return claim.type === "hardware" && PERSONAL_ATTRIBUTION.test(claim.claim);
}

function rewriteSentence(sentence: string, types: Set<ClaimType>, hasEvidence: boolean): string {
  const original = sentence.trim();
  if (types.has("responsibility") && !hasEvidence && /(?:我之前|我当时|我在项目里|我在项目中|我们项目|曾经|实际|最后定位|最后解决|做过|用过|调过|负责过|实现过|采用过)/u.test(original) && /(?:负责|主导|设计|实现|定位|解决|调试|使用|采用|优化|排查|修复|完成|搭建|开发)/u.test(original)) return "";
  const clauses = original.split(/(?<=[，,；;])/u).map((part) => part.trim()).filter(Boolean);
  const kept = clauses.filter((clause) => {
    MEASURED_VALUE.lastIndex = 0;
    const hasMetric = (types.has("metric") || types.has("result"))
      && (MEASURED_VALUE.test(clause) || RESULT_WORD.test(clause));
    MEASURED_VALUE.lastIndex = 0;
    RESULT_WORD.lastIndex = 0;
    if (hasMetric) {
      return false;
    }
    const hasOwnership = (types.has("responsibility") || types.has("personal_identity"))
      && /(?:我|我的|我们|本人).*(?:负责|主导|设计|实现|做过|解决|优化|承担|参与|发表|获得)/u.test(clause);
    if (hasOwnership) {
      if (hasEvidence && /(?:STM\d+[A-Z0-9]*|RK\d+|AS\d+[A-Z0-9]*|编码器|传感器|控制板|驱动板)/iu.test(clause)) {
        return clause.replace(/^(?:我|我的|我们|本人)(?:在项目中|在这个项目里|在项目里面)?\s*(?:主要)?(?:负责|主导|设计|实现|独立完成|做过|解决|优化|承担|参与)\s*/u, "项目中涉及 ");
      }
      return false;
    }
    if (types.has("hardware") && /(?:STM\d+[A-Z0-9]*|RK\d+|MCU|芯片|控制板|驱动板|处理器|传感器)/iu.test(clause)) {
      // A hardware noun may be generalized only when an evidence source still
      // supports the fact; otherwise the complete unsupported clause is gone.
      return hasEvidence;
    }
    return true;
  });
  if (!kept.length) return "";
  let rewritten = kept.join(" ").trim();
  if (types.has("hardware") && hasEvidence) rewritten = rewritten.replace(/(?:STM\d+[A-Z0-9]*|RK\d+)/gi, "芯片");
  if (rewritten === original) return "";
  return rewritten.replace(/[，、；;]+$/g, "").trim();
}

function splitSentences(answer: string): string[] {
  return answer.split(/(?<=[。！？!?；;\n])/).map((part) => part.trim()).filter(Boolean);
}

function usefulRewrite(answer: string, blocked: BlockedClaim[], hasEvidence: boolean): string {
  const blockedBySentence = new Map<string, Set<ClaimType>>();
  blocked.forEach((claim) => {
    const key = claim.claim.trim();
    const types = blockedBySentence.get(key) ?? new Set<ClaimType>();
    types.add(claim.type);
    blockedBySentence.set(key, types);
  });
  const rewritten = splitSentences(answer).map((sentence) => {
    const normalizedSentence = sentence.replace(/[。！？!?；;\n]+$/g, "").trim();
    let types = blockedBySentence.get(normalizedSentence);
    if (!types) {
      const matchingClaim = blocked.find((claim) => normalizedSentence.includes(claim.claim) || claim.claim.includes(normalizedSentence));
      types = matchingClaim ? blockedBySentence.get(matchingClaim.claim.trim()) : undefined;
    }
    const result = types ? rewriteSentence(sentence, types, hasEvidence) : sentence;
    return result;
  }).filter(Boolean);
  return rewritten.join(" ").trim();
}

function sanitizeClaimArtifacts(answer: string): string {
  return answer
    .replace(/具体量化结果未记录/g, "具体数字当前资料里没有确认，我不乱报")
    .replace(/具体数值/g, "具体数字")
    .replace(/相关硬件/g, "设备侧实现");
}

function partialFallback(blocked: BlockedClaim[], intent?: AnswerIntent): string {
  if (blocked.some((claim) => claim.type === "metric" || claim.type === "result")) {
    return "具体量化结果当前没有可靠记录，所以我不报一个不确定数字；方法上可以从现象、数据、根因和回归验证几个方面说明。";
  }
  if (intent?.asksBehavioralEpisode || blocked.some((claim) => claim.type === "responsibility")) {
    return "当前资料没有确认对应的个人职责，我不把推测说成经历；如果按通用方法回答，我会先说明背景和目标，再讲自己的处理步骤以及如何验证结果。";
  }
  return SAFE_GROUNDED_FALLBACK;
}

/**
 * Verifies personal claims against personal/session evidence while allowing
 * project facts and general knowledge to support technical explanations.
 */
export class ClaimGate {
  check(input: ClaimGateInput): ClaimGateResult {
    const answer = input.answer.trim();
    const personal = personalEvidence(input);
    const technical = technicalEvidence(input, personal);
    const allEvidence = dedupe([...technical, ...(input.evidenceSnapshot?.retrievedKnowledge ?? [])]);
    const validator = new ClaimEvidenceValidator();
    const personalValidation = validator.validate(answer, personal);
    const technicalValidation = validator.validate(answer, technical);
    const validation = validator.validate(answer, allEvidence);
    const pastActions = new PersonalPastActionDetector().detect(answer, personal);
    const historicalBlocks: BlockedClaim[] = pastActions.unsupported.map((finding) => ({ claim: finding.sentence.replace(/[。！？!?；;]+$/g, ""), type: "responsibility", status: "unsupported", provenance: "personal_ownership", risk: "high" }));
    const blockedClaims = [...validation.claims
      .map((claim) => claimStatus(claim, personalValidation, technicalValidation, validation))
      .filter((claim) => HIGH_RISK_CLAIM_TYPES.has(claim.type) && (claim.status === "unsupported" || claim.status === "partial" || claim.status === "conflicting"))
      .filter((claim) => requiresPersonalValidation(claim, input))
      .map((claim) => ({ claim: claim.claim, type: claim.type, status: claim.status as "unsupported" | "partial" | "conflicting", provenance: claim.provenance, risk: claim.risk })), ...historicalBlocks];
    const issues: string[] = [];
    const suggestions: string[] = [];
    if (!answer) {
      issues.push("empty-answer");
      suggestions.push("答案为空，不能提交到面试覆盖层");
    }
    if (blockedClaims.some((claim) => claim.type === "personal_identity")) {
      issues.push("personal-identity-unverified", "claim-gate-abstain");
      suggestions.push("身份、比赛、奖项、论文、专利、学校、公司和职位必须有可靠个人证据");
      return {
        decision: "abstain",
        allowed: false,
        score: 0,
        issues,
        suggestions,
        fallbackAnswer: SAFE_PERSONAL_IDENTITY_ABSTAIN,
        validation,
        blockedClaims,
        unsupportedPastPersonalActionCount: pastActions.unsupportedCount
      };
    }
    if (blockedClaims.length === 0 && answer) {
      const sanitized = sanitizeClaimArtifacts(answer);
      if (sanitized !== answer) {
        return { decision: "rewrite", allowed: true, score: validation.score, issues: [...issues, "claim-placeholder-sanitized"], suggestions, rewrittenAnswer: sanitized, validation, blockedClaims, unsupportedPastPersonalActionCount: pastActions.unsupportedCount };
      }
      return { decision: "allow", allowed: true, score: validation.score, issues, suggestions, validation, blockedClaims, unsupportedPastPersonalActionCount: pastActions.unsupportedCount };
    }
    if (blockedClaims.length > 0) {
      issues.push("claim-gate-rewrite");
      if (personal.length === 0 && blockedClaims.some((claim) => PERSONAL_CLAIM_TYPES.has(claim.type))) issues.push("missing-personal-evidence");
      if (blockedClaims.some((claim) => claim.status === "conflicting")) {
        issues.push("claim-evidence-conflicting");
        suggestions.push("保留当前 Session 或已确认资料中的版本，不要覆盖冲突事实");
      }
      if (blockedClaims.some((claim) => claim.status === "unsupported")) {
        issues.push("claim-evidence-unsupported");
        suggestions.push("只删除或弱化没有个人证据支持的职责、指标或结果，保留通用技术说明");
      }
      if (blockedClaims.some((claim) => claim.status === "partial")) {
        issues.push("claim-evidence-partial");
        suggestions.push("项目技术事实只能说明实现，不足以确认候选人的个人职责、指标或结果");
      }
      const directRewrite = usefulRewrite(answer, blockedClaims, technical.length > 0);
      const numericQuestion = /(?:多少|几路|几个|数字|数值|指标|比例|百分比|多大|多快|多长|多少毫秒|多少秒)/u.test(input.question);
      const numericDisclosure = numericQuestion && blockedClaims.some((claim) => claim.type === "metric" || claim.type === "result")
        ? "具体数字当前资料里没有确认，我不乱报。"
        : "";
      const rewrittenAnswer = sanitizeClaimArtifacts([directRewrite, numericDisclosure].filter(Boolean).join(" ") || partialFallback(blockedClaims, input.intent));
      const decision: ClaimGateDecision = directRewrite ? "rewrite" : "partial";
      return {
        decision,
        allowed: true,
        score: Math.max(0.45, validation.score),
        issues,
        suggestions,
        rewrittenAnswer,
        validation,
        blockedClaims,
        unsupportedPastPersonalActionCount: pastActions.unsupportedCount
      };
    }
    return {
      decision: "partial",
      allowed: true,
      score: 0.5,
      issues,
      suggestions,
      rewrittenAnswer: sanitizeClaimArtifacts(partialFallback([], input.intent)),
      validation,
      blockedClaims,
      unsupportedPastPersonalActionCount: pastActions.unsupportedCount
    };
  }

  evaluate(input: ClaimGateInput): ClaimGateResult { return this.check(input); }
}
