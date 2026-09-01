import { normalizeTechnicalTerms } from "../terminology";

export type AnswerQuestionKind =
  | "technical"
  | "concept"
  | "comparison"
  | "system-design"
  | "embedded-debugging"
  | "troubleshooting"
  | "code"
  | "project"
  | "behavioral"
  | "follow-up"
  | "short-clarification"
  | "deep-follow-up"
  | "clarification";

export type AnswerPlanQuestionType = AnswerQuestionKind | "project_troubleshooting";
export type AnswerEvidenceRequirement = "personal_project_fact" | "technical_fact" | "follow_up_context" | "prepared_answer";

export interface AnswerStrategy {
  id: AnswerPlanQuestionType;
  kind: AnswerQuestionKind;
  structure: readonly string[];
  requiredEvidence: readonly AnswerEvidenceRequirement[];
  mustUseFirstPerson: boolean;
  useCurrentProject: boolean;
  openingGuidance: string;
  spokenGuidance: string;
}
const ANSWER_KIND_HINTS: Record<string, AnswerQuestionKind> = {
  technical: "technical",
  project: "project",
  behavior: "behavioral",
  behavioral: "behavioral",
  follow_up: "follow-up",
  "follow-up": "follow-up",
  clarification: "clarification"
};

/** Routes a question to a response strategy instead of using one universal template. */
export function classifyAnswerQuestion(text: string, hint?: string): AnswerQuestionKind {
  const normalized = normalizeTechnicalTerms(text);
  if (hint === "follow-up" || hint === "FOLLOW_UP") return /具体|怎么|如何|设计|实现|分层|架构|排查|原因|取舍|为什么/iu.test(normalized) ? "deep-follow-up" : "short-clarification";
  if (hint && ANSWER_KIND_HINTS[hint]) return ANSWER_KIND_HINTS[hint];
  if (/代码|编程|手写|实现一个|写一个|补全|伪代码|算法题|时间复杂度|空间复杂度|输出结果|leetcode|debug|修复这段|code\b/i.test(normalized)) return "code";
  if (/系统设计|架构设计|设计一个系统|高并发|可扩展|容灾|降级|限流|服务拆分|数据库设计|缓存设计|消息队列/.test(normalized)) return "system-design";
  if (/区别|对比|比较|优缺点|取舍|权衡|为什么不用|选型|差异/.test(normalized)) return "comparison";
  if (/低速抖动|IIC.*卡死|HardFault|DMA.*异常|CAN.*丢帧|丢帧|数据异常/.test(normalized)) return "embedded-debugging";
  if (/排查|定位|故障|报错|异常|线上问题|怎么解决|如何解决|怎么验证|监控|告警/.test(normalized)) return "troubleshooting";
  if (/团队|冲突|压力|困难|失败|沟通|协作|领导|决策|优势|缺点|成长|资源有限|高目标|高压力|自主学习|案例/.test(normalized) && /你|我|经历|遇到|如何|分享/.test(normalized)) return "behavioral";
  if (/项目|负责|主导|经历|做过|落地|交付|简历|成果|业绩|为什么.*设计|怎么.*实现|遇到什么问题|怎么解决|具体实现/.test(normalized)) return "project";
  if (/上一题|刚才|继续|具体一点|展开|那如果|然后|还有/.test(normalized) && normalized.length < 34) return /具体|怎么|如何|设计|实现|分层|架构|排查|原因|取舍/.test(normalized) ? "deep-follow-up" : "short-clarification";
  if (/具体一点|什么意思|没听清|再说一遍|能展开|详细一点|指的是|怎么理解/.test(normalized)) return "clarification";
  if (/什么是|原理|定义|作用|为什么|如何|怎么|怎样|是什么/.test(normalized)) return "concept";
  return "technical";
}

const STRATEGIES: Record<AnswerQuestionKind, Omit<AnswerStrategy, "id">> = {
  technical: {
    kind: "technical",
    structure: ["direct_answer", "core_principle", "example_or_verification"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "第一句直接给出技术结论。",
    spokenGuidance: "只补充能帮助面试官判断理解程度的关键点，不展开成教材。"
  },
  concept: {
    kind: "concept",
    structure: ["definition", "why_or_how", "common_pitfall"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先用一句话解释它是什么或解决什么问题。",
    spokenGuidance: "术语第一次出现时给一个短解释，避免连续堆缩写。"
  },
  comparison: {
    kind: "comparison",
    structure: ["conclusion", "key_differences", "use_cases_and_tradeoffs"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先给选型结论，再说决定结论的差异。",
    spokenGuidance: "按对比维度组织短句，不强行加入个人项目经历。"
  },
  "system-design": {
    kind: "system-design",
    structure: ["requirements", "architecture", "critical_path", "tradeoffs", "failure_handling"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先确认需求和约束，再给整体架构。",
    spokenGuidance: "只覆盖能支撑设计决策的模块、链路和取舍。"
  },
  "embedded-debugging": {
    kind: "embedded-debugging",
    structure: ["symptom", "diagnosis_order", "root_cause", "fix", "verification"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先说最可能的原因和排查顺序。",
    spokenGuidance: "优先讲信号、时序、硬件连接、驱动状态和验证方式。"
  },
  troubleshooting: {
    kind: "troubleshooting",
    structure: ["symptom", "diagnosis", "root_cause", "fix", "verification"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先描述如何缩小问题范围，再给修复步骤。",
    spokenGuidance: "不要把通用排查方案说成候选人已经做过的经历。"
  },
  project: {
    kind: "project",
    structure: ["project_background", "personal_responsibility", "implementation", "challenge", "result"],
    requiredEvidence: ["personal_project_fact", "technical_fact"],
    mustUseFirstPerson: true,
    useCurrentProject: true,
    openingGuidance: "先说项目背景和我承担的范围。",
    spokenGuidance: "只使用已确认的个人事实；没有证据就明确说资料不足。"
  },
  behavioral: {
    kind: "behavioral",
    structure: ["context", "task", "action", "result"],
    requiredEvidence: ["personal_project_fact"],
    mustUseFirstPerson: true,
    useCurrentProject: false,
    openingGuidance: "先交代当时的背景和我面对的任务。",
    spokenGuidance: "用简化 STAR 讲行动和结果，不编造数字或职责。"
  },
  code: {
    kind: "code",
    structure: ["approach", "complete_code", "explanation", "complexity_and_edges"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先用短句说数据结构和算法选择。",
    spokenGuidance: "代码必须完整可运行，解释保持简短，不声称代码来自候选人项目。"
  },
  "follow-up": {
    kind: "follow-up",
    structure: ["new_detail", "direct_reason", "contextual_example"],
    requiredEvidence: ["follow_up_context", "technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: true,
    openingGuidance: "承接上一轮，只回答这次追问新增的部分。",
    spokenGuidance: "不要重新复述整段背景；优先使用当前主题、上一问和上一版回答。"
  },
  "short-clarification": {
    kind: "short-clarification",
    structure: ["new_detail", "direct_reason"],
    requiredEvidence: ["follow_up_context", "technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: true,
    openingGuidance: "只解释当前追问点，先给一句直接结论。",
    spokenGuidance: "控制在短澄清范围，不重复上一轮背景。"
  },
  "deep-follow-up": {
    kind: "deep-follow-up",
    structure: ["new_detail", "direct_reason", "contextual_example"],
    requiredEvidence: ["follow_up_context", "technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: true,
    openingGuidance: "承接上一轮，先说这次追问的核心设计或实现结论。",
    spokenGuidance: "允许完整覆盖方案、原因、关键细节和验证，不要机械重述上一轮。"
  },
  clarification: {
    kind: "clarification",
    structure: ["direct_explanation", "short_example"],
    requiredEvidence: ["technical_fact"],
    mustUseFirstPerson: false,
    useCurrentProject: false,
    openingGuidance: "先把被追问的概念换一种更清楚的说法。",
    spokenGuidance: "只补一个短例子，确认对方能继续追问即可。"
  }
};

export function answerStrategyFor(kind: AnswerQuestionKind, question = "", _hasProjectEvidence = false): AnswerStrategy {
  const base = STRATEGIES[kind];
  const projectTroubleshooting = (kind === "embedded-debugging" || kind === "troubleshooting")
    && /项目|经历|负责|做过|我在|当时|实际/.test(question);
  if (projectTroubleshooting) {
    return {
      ...base,
      id: "project_troubleshooting",
      mustUseFirstPerson: true,
      useCurrentProject: true,
      requiredEvidence: ["personal_project_fact", "technical_fact"],
      openingGuidance: "先说项目中出现的现象和我当时的判断。",
      spokenGuidance: "按现象、排查、根因、修复和结果讲，只使用有证据的个人经历。"
    };
  }
  return { ...base, id: kind };
}
