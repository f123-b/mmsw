import { classifyAnswerQuestion, type AnswerQuestionKind } from "./answer-strategy";
import { normalizeTechnicalTerms } from "../terminology";
import { analyzeQuestionNucleus } from "../question/question-nucleus";

export interface AnswerIntent {
  requiresPersonalIdentity: boolean;
  requiresPersonalOwnership: boolean;
  requiresPersonalMetric: boolean;
  requiresPersonalResult: boolean;
  asksProjectImplementation: boolean;
  technicalNucleusWithProjectAnchor: boolean;
  asksGeneralTechnicalKnowledge: boolean;
  asksBehavioralEpisode: boolean;
  allowsSessionEvidence: boolean;
  allowsResumeEvidence: boolean;
  allowsProjectEvidence: boolean;
  allowsGeneralKnowledge: boolean;
}

export interface AnswerIntentInput {
  question: string;
  kind?: AnswerQuestionKind;
}

const IDENTITY_QUESTION = /比赛|竞赛|奖项|获奖|论文|专利|实习|工作经历|哪个公司|哪家公司|学校|院校|专业|职位|岗位|担任什么|证书/;
const OWNERSHIP_QUESTION = /你(?:(?:在|于)?(?:这个)?项目(?:中|里|里面)|实际)?(?:主要)?(?:负责|主导|设计|实现|独立完成|做过|解决|优化|承担)|介绍一下你(?:的|负责|做过|参与)的项目/;
const METRIC_QUESTION = /\d+(?:\.\d+)?\s*(?:%|ms|us|秒|分钟|小时|天|Hz|MHz|kHz|MB|KB)|准确率|召回率|延迟|耗时|吞吐|占用率|性能|提升了多少|降低了多少|多少百分比|什么指标|量化|达到多少/;
const PERSONAL_TECHNICAL_METRIC_QUESTION = /你(?:的|们的).*(?:频率|波特率|延迟|耗时|吞吐|占用率|准确率|召回率|性能|指标|误差|周期|带宽|内存).*(?:多少|多大|几)/;
const RESULT_QUESTION = /结果|成果|效果|最后怎么样|最终如何|交付|上线|稳定运行|完成目标|达成目标/;
const PROJECT_CUE = /项目|系统中|模块中|链路中|这个结构|这套方案|实际实现|工程上/;
const IMPLEMENTATION_CUE = /怎么|如何|为什么|怎样|实现|封装|保证|设计|排查|定位|解决|优化|选择|采用|区别|原理/;
const BEHAVIORAL_CUE = /分享|案例|经历|高目标|高压力|资源有限|自主学习|团队|冲突|失败|沟通|协作|困难|压力/;
const TECHNICAL_CUE = /ADC|DMA|PWM|CAN|UART|I2C|IIC|SPI|FOC|SVPWM|RTOS|FreeRTOS|C\+\+|C语言|Linux|HardFault|watchdog|看门狗|驱动|抽象|仲裁|优先级反转|实时性|采样/;

export function analyzeAnswerIntent(input: AnswerIntentInput | string, kind?: AnswerQuestionKind): AnswerIntent {
  const question = typeof input === "string" ? input : input.question;
  const normalized = normalizeTechnicalTerms(question);
  const nucleus = analyzeQuestionNucleus(normalized);
  const resolvedKind = typeof input === "string" ? kind ?? classifyAnswerQuestion(normalized) : input.kind ?? classifyAnswerQuestion(normalized);
  const asksBehavioralEpisode = resolvedKind === "behavioral" || BEHAVIORAL_CUE.test(normalized) && /经历|案例|分享|如何处理|怎么做/.test(normalized);
  const technicalNucleusWithAnchor = nucleus.intent === "technical" && nucleus.contextAnchor.length > 0;
  const asksProjectImplementation = !technicalNucleusWithAnchor && PROJECT_CUE.test(normalized) && IMPLEMENTATION_CUE.test(normalized);
  const asksGeneralTechnicalKnowledge = !IDENTITY_QUESTION.test(normalized) && (
    ["technical", "concept", "comparison", "system-design", "embedded-debugging", "troubleshooting", "code", "clarification"].includes(resolvedKind)
    || TECHNICAL_CUE.test(normalized)
    || asksProjectImplementation
  );
  const requiresPersonalIdentity = IDENTITY_QUESTION.test(normalized) && !asksGeneralTechnicalKnowledge;
  const requiresPersonalOwnership = !technicalNucleusWithAnchor && !requiresPersonalIdentity && (OWNERSHIP_QUESTION.test(normalized) || asksBehavioralEpisode);
  const requiresPersonalMetric = !technicalNucleusWithAnchor && !requiresPersonalIdentity && (PERSONAL_TECHNICAL_METRIC_QUESTION.test(normalized) || METRIC_QUESTION.test(normalized) && (PROJECT_CUE.test(normalized) || asksBehavioralEpisode || resolvedKind === "follow-up" || /\d+(?:\.\d+)?\s*(?:%|ms|us|秒|分钟|小时|天|Hz|MHz|kHz|MB|KB)/.test(normalized)));
  const requiresPersonalResult = !technicalNucleusWithAnchor && !requiresPersonalIdentity && (RESULT_QUESTION.test(normalized) && (PROJECT_CUE.test(normalized) || asksBehavioralEpisode || resolvedKind === "follow-up"));
  return {
    requiresPersonalIdentity,
    requiresPersonalOwnership,
    requiresPersonalMetric,
    requiresPersonalResult,
    asksProjectImplementation,
    technicalNucleusWithProjectAnchor: technicalNucleusWithAnchor,
    asksGeneralTechnicalKnowledge,
    asksBehavioralEpisode,
    allowsSessionEvidence: true,
    allowsResumeEvidence: requiresPersonalIdentity || requiresPersonalOwnership || requiresPersonalMetric || requiresPersonalResult || asksBehavioralEpisode || asksProjectImplementation,
    allowsProjectEvidence: asksProjectImplementation || requiresPersonalOwnership || requiresPersonalMetric || requiresPersonalResult,
    allowsGeneralKnowledge: !requiresPersonalIdentity && (asksGeneralTechnicalKnowledge || asksBehavioralEpisode)
  };
}

export function requiresPersonalClaimEvidence(intent: AnswerIntent): boolean {
  return intent.requiresPersonalIdentity || intent.requiresPersonalOwnership || intent.requiresPersonalMetric || intent.requiresPersonalResult;
}
