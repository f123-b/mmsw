import type { EvidenceSnapshot } from "./evidence-context";
import { extractProjectClaims, type ProjectClaim } from "./claim-extractor";

export type ProjectTruthDecision = "ALLOW" | "REWRITE" | "BLOCK";
export type ProjectTruthStatus = "SUPPORTED" | "UNCERTAIN" | "CONTRADICTED" | "UNSUPPORTED";

export interface ProjectTruthFinding extends ProjectClaim {
  status: ProjectTruthStatus;
  matchedEvidence: string[];
}

export interface ProjectTruthGuardResult {
  decision: ProjectTruthDecision;
  answer: string;
  findings: ProjectTruthFinding[];
  blockedClaimCount: number;
  reason: string;
}

function compact(value: string): string { return value.toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”‘’（）()]/gu, ""); }
function evidenceFor(snapshot?: EvidenceSnapshot, evidence: readonly string[] = []): string[] {
  return [...new Set([...evidence, ...(snapshot?.sessionEvidence ?? []).map((item) => item.text), ...(snapshot?.candidateStatements ?? []).map((item) => item.text), ...(snapshot?.personalMemoryEvidence ?? []), ...(snapshot?.experienceContext ?? []), ...(snapshot?.verifiedResumeEvidence ?? []), ...(snapshot?.verifiedPersonalProjectFacts ?? []), ...(snapshot?.projectQaEvidence ?? []), ...(snapshot?.projectEvidence ?? [])].map((item) => item.trim()).filter(Boolean))];
}
function statusFor(claim: ProjectClaim, evidence: string[]): ProjectTruthStatus {
  if (!evidence.length) return "UNSUPPORTED";
  const answer = compact(claim.text);
  const matched = evidence.filter((item) => {
    const source = compact(item);
    if (claim.type === "team_size" && claim.value) return source.includes(compact(claim.value));
    const terms = claim.text.match(/STM\d+[A-Z0-9]*|RK\d+|ESP\d+|FOC|ADC|DMA|PWM|SPI|I2C|CAN|Linux|RTOS|\d+(?:\.\d+)?\s*(?:ms|us|秒|%|Hz|MHz|kHz|MB|KB|人)?/giu) ?? [];
    return terms.length ? terms.some((term) => source.includes(compact(term))) : source.includes(answer.slice(0, Math.min(12, answer.length)));
  });
  if (matched.length) return "SUPPORTED";
  if (claim.type === "team_size" && claim.value && evidence.some((item) => /(?:团队|项目|成员|人数).{0,12}\d+\s*人/iu.test(item))) return "CONTRADICTED";
  return "UNCERTAIN";
}

/** Claim-level safety gate for project/personal facts immediately before display. */
export class ProjectTruthGuard {
  check(input: { answer: string; evidenceSnapshot?: EvidenceSnapshot; evidence?: readonly string[] }): ProjectTruthGuardResult {
    const evidence = evidenceFor(input.evidenceSnapshot, input.evidence);
    const findings = extractProjectClaims(input.answer).map((claim) => ({ ...claim, status: statusFor(claim, evidence), matchedEvidence: evidence.filter((item) => compact(item).includes(compact(claim.value ?? claim.text.slice(0, 8)))) }));
    const blocked = findings.filter((finding) => finding.personal && finding.highRisk && (finding.status === "UNSUPPORTED" || finding.status === "CONTRADICTED"));
    const uncertain = findings.filter((finding) => finding.personal && finding.highRisk && finding.status === "UNCERTAIN");
    const unsafe = [...blocked, ...uncertain];
    if (!unsafe.length) return { decision: "ALLOW", answer: input.answer, findings, blockedClaimCount: 0, reason: "claims-grounded" };
    const unsafeSentences = new Set(unsafe.map((finding) => finding.text.trim()));
    const remaining = input.answer.split(/(?<=[。！？!?；;\n])/u).filter((sentence) => !unsafeSentences.has(sentence.trim())).join("").trim();
    const reason = blocked.some((finding) => finding.status === "CONTRADICTED")
      ? "contradicted-personal-claim"
      : blocked.length
        ? "unsupported-personal-claim"
        : "uncertain-personal-claim";
    return { decision: blocked.length && !remaining ? "BLOCK" : "REWRITE", answer: remaining || "具体个人事实当前没有被确认，我会以已核实资料为准。", findings, blockedClaimCount: blocked.length, reason };
  }
}

export function guardProjectTruth(input: { answer: string; evidenceSnapshot?: EvidenceSnapshot; evidence?: readonly string[] }): ProjectTruthGuardResult { return new ProjectTruthGuard().check(input); }
