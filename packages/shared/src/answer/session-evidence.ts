import type { ClaimProvenance, ClaimRisk } from "../knowledge/answer-validator";
import type { EvidenceItem } from "./evidence-context";
import { normalizeTechnicalTerms } from "../terminology";

export interface CandidateClaim {
  claim: string;
  provenance: ClaimProvenance;
  risk: ClaimRisk;
}

export interface CandidateStatementEvidence extends EvidenceItem {
  source: "candidate_statement";
  trust: "personal";
  verified: true;
  sessionId: string;
  questionId?: string;
  extractedClaims: CandidateClaim[];
  createdAt: number;
  confidence: number;
  verification: "candidate_asserted";
}

export interface CandidateStatementInput {
  sessionId: string;
  questionId?: string;
  text: string;
  createdAt?: number;
  confidence?: number;
}

const IDENTITY = /比赛|竞赛|奖项|获奖|论文|专利|实习|工作经历|公司|学校|院校|专业|职位|岗位|担任/;
const OWNERSHIP = /我(?:在项目中|在这个项目里|在项目里面)?(?:负责|主导|设计|实现|独立完成|做过|解决|优化|承担|参与)/;
const METRIC = /\d+(?:\.\d+)?\s*[x×]\s*\d+|\d+(?:\.\d+)?\s*(?:ms|us|秒|分钟|小时|天|周|个月|年|%|Hz|MHz|kHz|MB|KB|路|个)|准确率|召回率|延迟|耗时|吞吐量|占用率|提升|降低|下降|达到/;
const TECHNICAL = /STM\d+[A-Z0-9]*|RK\d+|FreeRTOS|RTOS|FOC|SVPWM|DMA|ADC|PWM|CAN|UART|I2C|IIC|SPI|MQTT|Linux|Python|C\+\+|SQLite|ROS2|驱动|采样|编码器|看门狗/i;

function compact(text: string): string {
  return normalizeTechnicalTerms(text).toLowerCase().replace(/[\s，。！？、,.!?；;:：()（）“”"'‘’]/g, "");
}

function extractClaims(text: string): CandidateClaim[] {
  return [...new Set(text.split(/[\n。！？!?；;]+/).map((part) => part.trim()).filter(Boolean))].flatMap((claim) => {
    const claims: CandidateClaim[] = [];
    if (IDENTITY.test(claim)) claims.push({ claim, provenance: "personal_identity", risk: "high" });
    if (OWNERSHIP.test(claim)) claims.push({ claim, provenance: "personal_ownership", risk: "high" });
    if (METRIC.test(claim)) claims.push({ claim, provenance: /提升|降低|下降|达到|准确率|延迟|耗时|吞吐|占用率/.test(claim) ? "personal_metric" : "personal_result", risk: "high" });
    if (TECHNICAL.test(claim)) claims.push({ claim, provenance: "project_technical_fact", risk: "medium" });
    return claims;
  });
}

function copyEvidence(item: CandidateStatementEvidence): CandidateStatementEvidence {
  return { ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) };
}

export class SessionEvidenceStore {
  private readonly statements: CandidateStatementEvidence[] = [];

  constructor(private readonly maxEntries = 48) {}

  reset(): void { this.statements.length = 0; }

  recordCandidateStatement(input: CandidateStatementInput): CandidateStatementEvidence | undefined {
    const text = normalizeTechnicalTerms(input.text).trim();
    if (!text) return undefined;
    const normalized = compact(text);
    const existing = this.statements.find((item) => compact(item.text) === normalized);
    if (existing) return copyEvidence(existing);
    const statement: CandidateStatementEvidence = {
      id: `candidate-statement-${input.sessionId}-${input.createdAt ?? Date.now()}-${this.statements.length}`,
      text,
      source: "candidate_statement",
      trust: "personal",
      verified: true,
      sessionId: input.sessionId,
      ...(input.questionId ? { questionId: input.questionId } : {}),
      extractedClaims: extractClaims(text),
      createdAt: input.createdAt ?? Date.now(),
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.9)),
      verification: "candidate_asserted"
    };
    this.statements.push(statement);
    while (this.statements.length > Math.max(1, this.maxEntries)) this.statements.shift();
    return copyEvidence(statement);
  }

  snapshot(): CandidateStatementEvidence[] { return this.statements.map(copyEvidence); }
  get size(): number { return this.statements.length; }
}
