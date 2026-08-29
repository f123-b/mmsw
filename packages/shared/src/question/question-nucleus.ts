import { normalizeTechnicalTerms } from "../terminology";

export type QuestionNucleusIntent = "technical" | "project_fact" | "project_implementation" | "behavioral" | "identity" | "unknown";

export interface QuestionNucleusAnalysis {
  contextAnchor: string;
  nucleus: string;
  intent: QuestionNucleusIntent;
  confidence: number;
  reason: string;
}

const TECHNICAL = /(?:原理|机制|作用|区别|怎么工作|如何工作|是什么|什么是|怎么实现|如何实现|性能|协议|线程|中断|调度|采样|仲裁|FOC|CAN|UART|DMA|RTOS|C\+\+|指针|内存|架构)/iu;
const PROJECT_FACT = /(?:你负责|你主导|你做过|你的项目|项目里|项目中|实际实现|你用过|简历里.*做过|经历)/iu;
const BEHAVIORAL = /(?:经历|案例|冲突|困难|压力|团队|沟通|失败|挑战|自主学习)/u;
const IDENTITY = /(?:比赛|获奖|奖项|论文|专利|学校|公司|职位|证书)/u;

/** Separates a project/context anchor from the actual requested proposition. */
export function analyzeQuestionNucleus(text: string): QuestionNucleusAnalysis {
  const normalized = normalizeTechnicalTerms(text).replace(/\s+/g, " ").trim();
  const parts = normalized.split(/[，,；;。！？?]/u).map((part) => part.trim()).filter(Boolean);
  const nucleus = parts.length > 1 ? parts[parts.length - 1] : normalized;
  const contextAnchor = parts.length > 1 ? parts.slice(0, -1).join("，") : "";
  const technicalNucleus = TECHNICAL.test(nucleus);
  if (IDENTITY.test(nucleus)) return { contextAnchor, nucleus, intent: "identity", confidence: 0.95, reason: "identity-nucleus" };
  if (BEHAVIORAL.test(nucleus)) return { contextAnchor, nucleus, intent: "behavioral", confidence: 0.9, reason: "behavioral-nucleus" };
  if (technicalNucleus && PROJECT_FACT.test(contextAnchor) && !PROJECT_FACT.test(nucleus)) return { contextAnchor, nucleus, intent: "technical", confidence: 0.96, reason: "technical-nucleus-with-project-anchor" };
  if (PROJECT_FACT.test(nucleus)) return { contextAnchor, nucleus, intent: /(?:怎么|如何|实现|设计|解决|定位|优化)/u.test(nucleus) ? "project_implementation" : "project_fact", confidence: 0.9, reason: "project-nucleus" };
  if (technicalNucleus) return { contextAnchor, nucleus, intent: "technical", confidence: 0.86, reason: "technical-nucleus" };
  return { contextAnchor, nucleus, intent: "unknown", confidence: 0.5, reason: "no-stable-nucleus" };
}
