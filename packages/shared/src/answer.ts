import type { InterviewMemorySnapshot } from "./interview-memory";
import { AnswerQualityChecker, type AnswerQualityResult } from "./answer/answer-quality-checker";
import { SpokenAnswerFormatter } from "./answer/spoken-answer-formatter";
import { AnswerPlanner, type AnswerPlan } from "./answer/answer-planner";
import { SpokenQualityChecker } from "./answer/spoken-quality-checker";
import { answerStrategyFor, classifyAnswerQuestion, type AnswerQuestionKind } from "./answer/answer-strategy";
import { sanitizeStreamingAnswer, StreamingAnswerSanitizer, stripClaimGateAuditText } from "./answer/streaming-answer-sanitizer";
import { normalizeTechnicalTerms } from "./terminology";
import { PersonalAnswerValidator, QuestionAnalyzer } from "./knowledge/index";
import type { FollowUpContext } from "./follow-up-context";
import type { QuestionBankRouteHit } from "./question-bank-router";
import { planAnswerSource, type AnswerSourcePlan } from "./answer/project-answer-source-planner";
import { ClaimGate } from "./answer/claim-gate";
import { createEvidenceSnapshot, type EvidenceSnapshot } from "./answer/evidence-context";
import { analyzeAnswerIntent, requiresPersonalClaimEvidence } from "./answer/answer-intent";
import type { CandidateStatementEvidence } from "./answer/session-evidence";
import { multiSlotPrompt } from "./question/question-decomposer";
import { classifyQuestionSemanticFrame } from "./question/semantic-frame";
import { matchCoreTechnicalQa, type CoreTechnicalQaCard } from "./answer/core-technical-qa";
import { TechnicalAccuracyGuard } from "./answer/technical-accuracy-guard";
import { enforceHrProfilePolicy } from "./answer/hr-profile-policy";
import { ProjectTruthGuard } from "./answer/project-truth-guard";
import { AnswerPlanCoverageChecker, type AnswerCoverageResult } from "./answer/answer-plan-coverage-checker";
import { AnswerDepthRepair } from "./answer/answer-depth-repair";

export { planAnswerSource } from "./answer/project-answer-source-planner";
export type { AnswerSourcePlan, AnswerSourceMode } from "./answer/project-answer-source-planner";

export * from "./answer/claim-gate";
export * from "./answer/evidence-context";
export * from "./answer/answer-intent";
export * from "./answer/project-question-intent";
export * from "./answer/project-qa-generator";
export * from "./answer/session-evidence";
export * from "./answer/core-technical-qa";
export * from "./answer/technical-accuracy-guard";
export * from "./answer/chinese-technical-language-policy";
export * from "./answer/hr-profile-policy";
export * from "./answer/claim-extractor";
export * from "./answer/project-truth-guard";

export type AnswerMode = "FAST" | "NORMAL" | "DEEP";
export { classifyAnswerQuestion } from "./answer/answer-strategy";
export type { AnswerEvidenceRequirement, AnswerPlanQuestionType, AnswerQuestionKind, AnswerStrategy } from "./answer/answer-strategy";
export type { AnswerPlan, AnswerPlannerInput } from "./answer/answer-planner";
export type { AnswerDurationRange, AnswerLengthPolicy } from "./answer/answer-length-controller";
export { AnswerPlanner } from "./answer/answer-planner";

export interface AnswerQuestion {
  id: string;
  text: string;
  /** Optional detector hint. The answer router still validates it from text. */
  kind?: AnswerQuestionKind;
}

export interface AnswerSkillContext {
  id: string;
  name: string;
  content: string;
  relevance?: number;
}

/** Bounded, explainable metadata attached to every completed answer. */
export interface AnswerTelemetry {
  rawText?: string;
  normalizedText?: string;
  canonicalText?: string;
  terminologyCorrectionCount?: number;
  terminologyPossibleTerms?: string[];
  terminologyConfidence?: number;
  unresolvedAsr?: boolean;
  asrUnderstandingQuality?: string;
  speechAct?: string;
  speechActReason?: string;
  turnCompletionState?: string;
  turnCompletionConfidence?: number;
  turnCompletionReason?: string;
  semanticFrame?: string;
  topicRelation?: string;
  contextRelation?: string;
  parentQuestionId?: string;
  rootQuestionId?: string;
  projectAnchorAvailable?: boolean;
  projectQuestionRequested?: boolean;
  projectQuestionMode?: string;
  utteranceCompleteness?: string;
  activeProjectId?: string;
  activeProjectConfidence?: number;
  topic?: string;
  questionRelation?: string;
  projectQaMatch?: string;
  projectFactCount?: number;
  sessionEvidenceCount?: number;
  firstTokenMs?: number;
  answerTotalMs?: number;
  questionDebounceMs?: number;
  projectAutoAnchorId?: string;
  projectAutoAnchorConfidence?: number;
  questionNucleusIntent?: string;
  questionNucleus?: string;
  answerSourceMode?: string;
  coreQaMatchLevel?: string;
  coreQaQuestionId?: string;
  coreQaScore?: number;
  projectQaMatchLevel?: string;
  projectQaQuestionId?: string;
  selfIntroductionDetected?: boolean;
  selfIntroductionDirect?: boolean;
  selfIntroductionRewrite?: boolean;
  projectOverviewHitCount?: number;
  projectCacheHit?: boolean;
  projectResolutionReason?: string;
  technicalGuardDecision?: "allow" | "rewrite";
  technicalGuardIssues?: string[];
  technicalViolationCount?: number;
  claimGateDecision?: "allow" | "rewrite" | "partial" | "abstain";
  blockedPersonalClaimCount?: number;
  blockedClaimCount?: number;
  projectTruthDecision?: "ALLOW" | "REWRITE" | "BLOCK";
  blockedClaimTypes?: string[];
  unsupportedPastPersonalActionCount?: number;
  historyRevision?: number;
  asrFinalToQuestionConfirmedMs?: number;
  questionConfirmedToProviderRequestMs?: number;
  providerRequestToFirstTokenMs?: number;
  asrFinalToFirstVisibleTokenMs?: number;
  fastContextMs?: number;
  claimGateMs?: number;
  /** Compatibility aliases used by runtime dashboards. */
  providerFirstTokenMs?: number;
  asrFinalToFirstTokenMs?: number;
  timings?: Record<string, number | undefined>;
  coveredFacets?: string[];
  missingFacets?: string[];
  requiredFacets?: string[];
  initialAnswerCharacterCount?: number;
  finalAnswerCharacterCount?: number;
  answerCharacterCount?: number;
  answerEstimatedDurationSec?: number;
  answerDepthPass?: boolean;
  answerRepairApplied?: boolean;
  answerRuntimeTrace?: AnswerRuntimeTrace;
}

export interface AnswerRuntimeTrace {
  questionId?: string;
  answerId?: string;
  sourceMode?: string;
  requiredFacets: string[];
  coveredFacets: string[];
  missingFacets: string[];
  initialCharacterCount: number;
  finalCharacterCount: number;
  estimatedDurationSec: number;
  depthPass: boolean;
  needsRepair: boolean;
  repairApplied: boolean;
}

export interface PreparedAnswer {
  content: string;
  score: number;
  verified: boolean;
  source?: string;
  answerCardId?: string;
  questionId?: string;
  stale?: boolean;
}

export interface AnswerContextInput {
  /** Identifies whether this context was built on the first-token path. */
  contextMode?: "fast" | "rich";
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  expressionLevel?: "plain" | "standard" | "expert";
  explainAdvancedTerms?: boolean;
  skills?: AnswerSkillContext[];
  experienceContext?: string[];
  personalMemoryEvidence?: string[];
  retrievedKnowledge?: string[];
  preparedAnswer?: PreparedAnswer;
  /** Approved, current self-introduction cached for the live fast lane. */
  selfIntroduction?: { id: string; text: string; approved: boolean; language: string; targetDurationSeconds?: number };
  questionBankMatches?: QuestionBankRouteHit[];
  answerSourcePlan?: AnswerSourcePlan;
  coreTechnicalQa?: CoreTechnicalQaCard;
  companyContext?: string;
  salaryExpectation?: import("./profile").SalaryExpectation;
  projectQaEvidence?: string[];
  currentProject?: string;
  currentTopic?: string;
  currentModule?: string;
  projectEvidence?: string[];
  verifiedResumeEvidence?: string[];
  verifiedPersonalProjectFacts?: string[];
  recentTranscript?: string[];
  interviewMemory?: InterviewMemorySnapshot;
  followUpContext?: FollowUpContext;
  sessionEvidence?: CandidateStatementEvidence[];
  candidateStatements?: CandidateStatementEvidence[];
  /** Evidence captured for this question; when present it is authoritative. */
  evidenceSnapshot?: EvidenceSnapshot;
  questionTelemetry?: Partial<AnswerTelemetry>;
  /** Byte-stable context supplied for every answer in an interview. */
  stableInterviewPrefix?: string;
  /** Bounded rolling state; it is advisory and never replaces evidence. */
  interviewMemo?: string;
}

export interface ContextPack {
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  expressionLevel: "plain" | "standard" | "expert";
  explainAdvancedTerms: boolean;
  skills: AnswerSkillContext[];
  experienceContext: string[];
  personalMemoryEvidence: string[];
  retrievedKnowledge: string[];
  preparedAnswer?: PreparedAnswer;
  questionBankMatches: QuestionBankRouteHit[];
  answerSourcePlan?: AnswerSourcePlan;
  coreTechnicalQa?: CoreTechnicalQaCard;
  companyContext?: string;
  salaryExpectation?: import("./profile").SalaryExpectation;
  projectQaEvidence: string[];
  currentProject?: string;
  currentTopic?: string;
  currentModule?: string;
  projectEvidence: string[];
  verifiedResumeEvidence: string[];
  verifiedPersonalProjectFacts: string[];
  recentTranscript: string[];
  interviewMemory?: InterviewMemorySnapshot;
  followUpContext?: FollowUpContext;
  evidenceSnapshot?: EvidenceSnapshot;
  sessionEvidence: CandidateStatementEvidence[];
  candidateStatements: CandidateStatementEvidence[];
  questionTelemetry?: Partial<AnswerTelemetry>;
  stableInterviewPrefix?: string;
  interviewMemo?: string;
}

function answerTokenBudget(mode: AnswerMode, kind: AnswerQuestionKind, plan?: AnswerPlan): number {
  if (kind === "code") return mode === "FAST" ? 1_024 : mode === "DEEP" ? 2_400 : 1_600;
  const baseline = mode === "FAST" ? 768 : mode === "DEEP" ? 2_048 : 1_536;
  return Math.max(baseline, plan ? Math.ceil(plan.length.maxCharacters / 1.8) : baseline);
}

function relevance(question: string, skill: AnswerSkillContext): number {
  const tokens = normalizeTechnicalTerms(question).toLowerCase().match(/[a-z0-9+#]+|[\u4e00-\u9fff]{2,}/gi) ?? [];
  const content = normalizeTechnicalTerms(`${skill.name} ${skill.content}`).toLowerCase();
  return tokens.filter((token) => content.includes(token)).length / Math.max(1, tokens.length);
}

export class ContextRouter {
  route(question: string, input: AnswerContextInput = {}): ContextPack {
    const snapshot = input.evidenceSnapshot;
    const answerSourcePlan = snapshot?.answerSourcePlan ?? input.answerSourcePlan;
    const projectContextUnresolved = answerSourcePlan?.mode === "project_context_unresolved";
    const projectQaEvidence = projectContextUnresolved ? [] : snapshot?.projectQaEvidence ?? input.projectQaEvidence ?? [];
    const directProjectQa = answerSourcePlan?.mode === "project_qa_direct";
    const selfIntroduction = answerSourcePlan?.mode === "self_intro_direct" || answerSourcePlan?.mode === "self_intro_rewrite";
    const coreTechnicalQa = directProjectQa || answerSourcePlan?.projectQuestionRequested ? undefined : input.coreTechnicalQa ?? matchCoreTechnicalQa(question);
    const routedSessionEvidence = snapshot
      ? (snapshot.sessionEvidence ?? snapshot.candidateStatements ?? [])
      : [...(input.sessionEvidence ?? []), ...(input.candidateStatements ?? [])];
    const skills = (input.skills ?? [])
      .map((skill) => ({ ...skill, relevance: skill.relevance ?? relevance(question, skill) }))
      .filter((skill) => (skill.relevance ?? 0) > 0)
      .sort((left, right) => (right.relevance ?? 0) - (left.relevance ?? 0))
      .slice(0, 3);
    let transcriptBudget = 2_400;
    const recentTranscript = (snapshot?.recentTranscript ?? input.recentTranscript ?? []).slice(-12).reverse().map((line) => line.slice(0, 500)).filter((line) => {
      if (transcriptBudget <= 0) return false;
      transcriptBudget -= line.length;
      return true;
    }).reverse();
    return {
      profileSummary: snapshot?.profileSummary ?? input.profileSummary,
      jobDescriptionSummary: snapshot?.jobDescriptionSummary ?? input.jobDescriptionSummary,
      profileInstructions: snapshot?.profileInstructions ?? input.profileInstructions,
      expressionLevel: input.expressionLevel ?? "plain",
      explainAdvancedTerms: input.explainAdvancedTerms ?? true,
      skills,
      experienceContext: (snapshot?.experienceContext ?? input.experienceContext ?? []).slice(0, 5),
      personalMemoryEvidence: (snapshot?.personalMemoryEvidence ?? input.personalMemoryEvidence ?? []).slice(0, 5),
      retrievedKnowledge: directProjectQa || selfIntroduction || Boolean(coreTechnicalQa) || projectContextUnresolved ? [] : (snapshot?.retrievedKnowledge ?? input.retrievedKnowledge ?? []).slice(0, 6),
      ...(projectContextUnresolved ? {} : (input.preparedAnswer ? { preparedAnswer: input.preparedAnswer } : {})),
      questionBankMatches: (input.questionBankMatches ?? []).slice(0, 5),
      ...(answerSourcePlan ? { answerSourcePlan } : {}),
      ...(coreTechnicalQa ? { coreTechnicalQa } : {}),
      ...(input.companyContext ? { companyContext: input.companyContext } : {}),
      ...(input.salaryExpectation ? { salaryExpectation: { ...input.salaryExpectation } } : {}),
      projectQaEvidence: projectQaEvidence.slice(0, 8),
      ...(projectContextUnresolved ? {} : { currentProject: snapshot?.currentProject ?? input.currentProject }),
      currentTopic: snapshot?.currentTopic ?? input.currentTopic,
      currentModule: snapshot?.currentModule ?? input.currentModule,
      projectEvidence: directProjectQa || selfIntroduction || projectContextUnresolved ? [] : (snapshot?.projectEvidence ?? input.projectEvidence ?? input.personalMemoryEvidence ?? input.experienceContext ?? []).slice(0, 8),
      verifiedResumeEvidence: (snapshot?.verifiedResumeEvidence ?? input.verifiedResumeEvidence ?? []).slice(0, 5),
      verifiedPersonalProjectFacts: (snapshot?.verifiedPersonalProjectFacts ?? input.verifiedPersonalProjectFacts ?? []).slice(0, 8),
      recentTranscript,
      interviewMemory: snapshot?.interviewMemory ?? input.interviewMemory,
      followUpContext: input.followUpContext,
      evidenceSnapshot: snapshot,
      ...(input.stableInterviewPrefix ? { stableInterviewPrefix: input.stableInterviewPrefix } : {}),
      ...(input.interviewMemo ? { interviewMemo: input.interviewMemo } : {}),
      sessionEvidence: routedSessionEvidence.map((item) => ({ ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) })),
      candidateStatements: routedSessionEvidence.map((item) => ({ ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) }))
      ,...(input.questionTelemetry ? { questionTelemetry: { ...input.questionTelemetry } } : {})
    };
  }
}

export interface PromptSection {
  name: "system/base" | "stable-prefix" | "rolling-memo" | "interview-style" | "project-qa-context" | "core-qa-context" | "profile-context" | "skill-context" | "experience-context" | "evidence-context" | "retrieval-context" | "question-bank-context" | "recent-transcript" | "interview-memory" | "follow-up-context" | "multi-slot-context" | "conversation-history" | "question" | "output-format";
  content: string;
}

export class PromptBuilder {
  build(question: AnswerQuestion, mode: AnswerMode, context: ContextPack, plan?: AnswerPlan): PromptSection[] {
    const kind = plan?.kind ?? classifyAnswerQuestion(question.text, question.kind);
    const selectedStrategy = plan?.strategy ?? answerStrategyFor(kind, question.text, context.projectEvidence.length > 0);
    const intent = plan?.intent ?? analyzeAnswerIntent({ question: question.text, kind });
    const personalClaimRequested = requiresPersonalClaimEvidence(intent) || intent.asksBehavioralEpisode;
    const hrFrame = classifyQuestionSemanticFrame(question.text);
    const hrContextRequested = hrFrame === "company" || hrFrame === "salary";
    const projectContextRequested = intent.asksProjectImplementation || intent.allowsProjectEvidence;
    const sourceMode = context.answerSourcePlan?.mode;
    const sections: PromptSection[] = [
      ...(context.stableInterviewPrefix ? [{ name: "stable-prefix" as const, content: context.stableInterviewPrefix }] : []),
      { name: "system/base", content: `你是实时面试辅助。先判断题型，再按题型回答。回答必须真实、直接、便于候选人马上口述；第一句必须回应面试官当前问题，不能输出“面试策略”或“面试官一般喜欢”。不要输出“题库参考答案”“Resume”“岗位要求”“结构化项目事实”等资料标签，也不要评价面试官。嵌入式问题要使用标准专业术语，并根据上下文区分 Cortex-M、ARM32、ARM64、RTOS、Embedded Linux 等语境，不能把不同平台的概念混为一谈。项目资料只能增强项目实现说明，不能决定通用技术题是否可回答；[PROJECT_SOURCE] 不能自动证明个人职责或指标，[GLOBAL_REFERENCE] 只能解释通用概念；第一人称个人事实只能来自已确认的个人或当前面试陈述。项目技术事实可以改写成“我这个项目里用的是 X”，但除非 Personal Ownership Evidence 明确支持，不能改写成“我设计了 X”“我负责 X”“我主导 X”“我独立完成 X”或“我决定使用 X”。${sourceMode ? `当前回答源模式：${sourceMode}。` : ""}${personalClaimRequested ? "当前需要个人经历表达：可以使用可追溯的个人素材；没有确认的身份、职责、指标或结果必须弱化或明确说明。" : intent.asksProjectImplementation ? "当前问题关注项目实现：可以讲项目技术事实和通用工程方法，但不要把项目实现自动说成候选人本人负责。" : "当前不是个人经历问题：直接回答技术问题，不要为了个性化而虚构候选人经历。"}` },
      { name: "interview-style", content: `题型：${plan?.questionType ?? kind}。回答模式：${mode}。回答策略：${selectedStrategy.openingGuidance}${selectedStrategy.spokenGuidance}${new SpokenAnswerFormatter().instructions(mode, kind, plan)}` }
    ];
    if (context.interviewMemo?.trim()) sections.push({ name: "rolling-memo", content: `这是当前面试的滚动备忘，只用于保持上下文一致；它不是事实证据，个人事实仍必须以证据快照为准。\n${context.interviewMemo.trim()}` });
    const expressionInstruction = context.expressionLevel === "expert"
      ? "可以使用业内标准专业表达，但避免无意义堆砌术语。"
      : context.expressionLevel === "standard"
        ? "使用常见技术词汇；遇到不常见术语，用一句短解释说明它是什么。"
        : "优先使用简单、口语化的中文。必须使用专业词时，紧接一句通俗解释，不连续堆叠缩写。";
    sections.push({ name: "interview-style", content: `表达难度：${context.expressionLevel}。${expressionInstruction}${context.explainAdvancedTerms ? " 首次出现较难术语时，用括号或短句解释。" : " 不额外展开术语定义。"}` });
    if ((sourceMode === "project_qa_direct" || sourceMode === "project_qa_augmented") && context.preparedAnswer?.content.trim()) {
      const direct = sourceMode === "project_qa_direct";
      sections.push({ name: "project-qa-context", content: `${direct ? "这是当前项目已确认的标准答案。以它为事实底稿，只做口语化改写和必要的当前问题对齐；保留原答案中的事实、技术选择、数字和边界，不要新增项目事实。" : "这是当前项目的相似标准答案。优先复用其中已确认的事实，再结合项目资料补足当前问题；不能把未确认内容写成候选人亲自负责。"}\n${context.preparedAnswer.content}` });
    }
    if (sourceMode === "self_intro_rewrite" && context.preparedAnswer?.content.trim()) {
      sections.push({ name: "experience-context", content: `这是候选人已审核的自我介绍底稿。只根据当前问题的时长、语言和表达要求做轻量改写，不得新增简历、项目、职责或指标事实；只输出改写后的自我介绍。\n${context.preparedAnswer.content}` });
    }
    if (context.coreTechnicalQa?.verified && sourceMode === "general_core_qa") {
      const card = context.coreTechnicalQa;
      sections.push({ name: "core-qa-context", content: `这是已审核的通用核心技术事实（${card.id}，版本 ${card.version}）。只能在不改变事实的前提下口语化改写；不要引入项目经历、未经审核的数字或相反结论。\n短答：${card.shortAnswer}\n标准答：${card.normalAnswer}\n深答：${card.deepAnswer}` });
    }
    const experienceRequested = personalClaimRequested;
    if ((personalClaimRequested || hrContextRequested) && (context.profileSummary || context.jobDescriptionSummary || context.profileInstructions || context.companyContext || context.salaryExpectation)) sections.push({ name: "profile-context", content: [context.profileSummary, context.jobDescriptionSummary, context.profileInstructions ? `候选人回答偏好：${context.profileInstructions}` : "", hrContextRequested && context.companyContext ? `已确认的公司/业务资料：${context.companyContext}` : "", hrContextRequested && context.salaryExpectation ? `已配置薪资口径：${JSON.stringify(context.salaryExpectation)}` : ""].filter(Boolean).join("\n") });
    if (context.skills.length > 0) sections.push({ name: "skill-context", content: context.skills.map((skill) => `${skill.name}: ${skill.content}`).join("\n") });
    if (personalClaimRequested && context.sessionEvidence.length > 0) sections.push({ name: "experience-context", content: `当前面试中候选人已经明确说过的事实（来源为 candidate_asserted，只能承接为候选人当前声称过的内容，不能擅自升级为已验证结果）：\n${context.sessionEvidence.map((item) => item.text).join("\n---\n")}` });
    if (personalClaimRequested && context.personalMemoryEvidence.length > 0) sections.push({ name: "experience-context", content: `以下是优先级最高的个人工程经验。必须用第一人称，只使用其中有证据的内容；没有记录的内容明确说资料不足：\n${context.personalMemoryEvidence.join("\n---\n")}` });
    if (experienceRequested && context.experienceContext.length > 0) sections.push({ name: "experience-context", content: `以下是真实经历素材。只使用与问题直接相关的内容，不能补写未出现的事实：\n${context.experienceContext.join("\n---\n")}` });
    const projectKnowledgeSource = sourceMode === "project_qa_augmented" || sourceMode === "project_knowledge_generated";
    if ((projectContextRequested || projectKnowledgeSource) && context.projectEvidence.length > 0) {
      sections.push({ name: "experience-context", content: `以下是已确认的项目技术证据。它只能支持项目实现说明，不能自动证明候选人的个人职责、指标或结果：\n${context.projectEvidence.join("\n---\n")}` });
    }
    if ((personalClaimRequested || projectContextRequested) && context.evidenceSnapshot) {
      sections.push({ name: "evidence-context", content: `证据快照已锁定：${context.evidenceSnapshot.id}（指纹 ${context.evidenceSnapshot.fingerprint}）。候选人当前面试陈述可证明“候选人声称过”，PROJECT_SOURCE 只能解释实现，不能自动证明个人职责或指标。` });
    }
    if (context.retrievedKnowledge.length > 0) sections.push({ name: "retrieval-context", content: `资料分层规则：PROJECT_SOURCE 仅辅助实现说明；GLOBAL_REFERENCE 仅解释通用知识，不能形成项目事实或个人经历。\n${context.retrievedKnowledge.join("\n---\n")}` });
    if (context.questionBankMatches.length > 0 && sourceMode !== "project_qa_direct") sections.push({ name: "question-bank-context", content: `以下是题库路由结果，仅用于选择已整理素材和判断题型；不要把题库内容当成个人经历证据：\n${context.questionBankMatches.map((hit) => `${hit.question.bankType}/${hit.question.category}（语义 ${Math.round(hit.semanticScore * 100)}%，优先级 ${hit.priority}%）：${hit.question.canonicalText}${hit.reasons.length ? ` [${hit.reasons.join(", ")}]` : ""}`).join("\n")}` });
    if (context.followUpContext) {
      const followUp = context.followUpContext;
      sections.push({ name: "follow-up-context", content: [
        `Root Question：${followUp.rootQuestion}`,
        `Parent Question：${followUp.parentQuestion}`,
        followUp.parentAnswer ? `Parent Answer：${followUp.parentAnswer}` : "",
        `Current Follow-up：${followUp.currentQuestion}`,
        followUp.currentTopic ? `Current Topic：${followUp.currentTopic}` : "",
        followUp.relatedProject ? `Related Project：${followUp.relatedProject}` : "",
        followUp.relatedTechnicalTopic ? `Related Technical Topic：${followUp.relatedTechnicalTopic}` : ""
      ].filter(Boolean).join("\n") });
    } else if (context.recentTranscript.length > 0) {
      sections.push({ name: "recent-transcript", content: `最近必要对话：\n${context.recentTranscript.join("\n")}` });
    }
    if (context.interviewMemory) {
      const memory = context.interviewMemory;
      const turns = context.followUpContext ? "" : memory.turns.slice(-10).map((turn) => `问题：${turn.question}${turn.answer ? `\n回答：${turn.answer}` : ""}`).join("\n");
      if (!context.followUpContext || memory.currentTopic) sections.push({ name: "interview-memory", content: [`当前主题：${memory.currentTopic || "未确定"}`, turns].filter(Boolean).join("\n") });
    }
    sections.push({ name: "question", content: question.text });
    if (plan?.questionDecomposition?.isMultiSlot) sections.push({ name: "multi-slot-context", content: multiSlotPrompt(plan.questionDecomposition) });
    const length = plan
      ? `${plan.length.minCharacters}~${plan.length.maxCharacters} 字，目标 ${plan.targetDurationSec} 秒`
      : kind === "code"
        ? mode === "FAST" ? "先给最小可运行代码和一句解释" : "完整代码、关键解释、复杂度和边界情况"
        : mode === "FAST" ? "60-120" : mode === "DEEP" ? "240-576" : "120-288";
    const strategy = {
      code: "严格按四段输出：①“给面试官的思路”用可直接口述的短句说明数据结构、算法和选择原因；②给完整代码：必须是可编译运行的代码块（题目未指定语言时默认 C++17，包含必要头文件、函数/类定义和可执行入口或清晰调用方式）；③解释关键代码；④时间/空间复杂度、边界情况和可追问点。代码不要只写片段，也不要声称来自候选人的项目。",
      "system-design": "按需求和约束、整体架构、核心链路、数据一致性/稳定性、扩展性和权衡回答；只有明确问到项目时才引用项目。",
      comparison: "先给结论，再按核心差异、适用场景、优缺点和选型依据对比，不要强行加入项目经历。",
      troubleshooting: "按现象、可能原因、定位步骤、修复方案和验证方式回答；不要把排查方案包装成候选人已经做过的经历。",
      "embedded-debugging": "先说现象，再给最可能原因和排查顺序，最后说明如何验证；优先覆盖信号/时序、硬件连接、驱动状态和边界条件，不要虚构候选人的实际经历。",
      project: "只使用提供的简历、项目和面试素材，按‘核心回答、项目经历、具体实现、问题解决’组织，但要像面试口述一样自然，不要机械套模板；资料没有的内容明确说没有证据。",
      behavioral: "使用真实经历回答，按情境、任务、行动、结果和反思组织；没有对应经历就说明资料不足，不要编造。",
      "follow-up": "承接上一轮上下文，只补充面试官追问的新增信息，不重复整段答案。",
      "short-clarification": "只补充当前追问点，控制在短澄清范围，不重复整段答案。",
      "deep-follow-up": "承接上一轮上下文，补充设计、实现、原因和验证等新增细节，不重复整段背景。",
      clarification: "先直接解释被追问的概念，再用一个简短例子说明。",
      concept: "先给定义或结论，再解释原理、关键点和常见误区；不要为了显得个性化而硬塞项目经历。",
      technical: "直接回答技术问题，再补充关键依据、风险或验证方式；只有问题明确要求时才引用项目。"
    }[kind];
    const explicitQuestionCount = question.text.match(/[？?]/g)?.length ?? 0;
    const multiQuestionInstruction = explicitQuestionCount >= 2 || /(?:以及|并且|同时|另外).{0,24}(?:什么|怎么|如何|哪些|区别|场景)/.test(question.text)
      ? "检测到同一轮包含多个子问题：必须在一次回答中按原顺序逐项覆盖，每个子问题只回答一次，不能只保留最后一题。"
      : "";
    sections.push({ name: "output-format", content: kind === "code" ? `${multiQuestionInstruction}${strategy} 保证答案完整，不要在代码或解释中途截断。` : `${multiQuestionInstruction}回答长度或结构：${length}。结构顺序：${plan?.structure.join(" → ") ?? "结论 → 关键点 → 必要的验证方式"}。${strategy} 不要写“首先/其次/最后”的模板化标题，不要百科式展开。` });
    return sections;
  }
}

export type ModelRoute = "fast" | "normal" | "reasoning" | "vision" | "low-latency";
export type ModelSnapshot = Partial<Record<ModelRoute, string>> & { fallback?: string };

export interface ModelSelection {
  route: ModelRoute;
  model: string;
}

export class ModelRouter {
  constructor(private readonly models: Partial<Record<ModelRoute, string>> = {}, private fallbackModel = "") {}

  setModels(models: Partial<Record<ModelRoute, string>>): void {
    Object.assign(this.models, models);
  }

  setFallbackModel(model: string): void { this.fallbackModel = model; }

  snapshot(): ModelSnapshot { return { ...this.models, fallback: this.fallbackModel }; }

  select(question: string, mode: AnswerMode = "NORMAL", hasScreenshot = false, override?: ModelSnapshot): ModelSelection {
    const route: ModelRoute = hasScreenshot ? "vision" : mode === "FAST" ? "fast" : mode === "DEEP" ? "reasoning" : "normal";
    const models = override ?? this.models;
    const fallback = override?.fallback ?? this.fallbackModel;
    return { route, model: models[route] ?? (route === "normal" ? models["low-latency"] : undefined) ?? fallback };
  }
}

export interface AnswerProviderRequest {
  model: string;
  sections: PromptSection[];
  attachments?: Array<{ mimeType: string; dataUrl: string }>;
  thinking?: boolean;
  /** Provider-side output budget. Prevents default server limits cutting an answer off. */
  maxOutputTokens?: number;
  /** Optional per-request retry override. */
  maxRetries?: number;
}

export interface AnswerProvider {
  stream(request: AnswerProviderRequest, signal?: AbortSignal): AsyncIterable<string>;
  /** Optional non-streaming completion path used by the interview UI. */
  complete?(request: AnswerProviderRequest, signal?: AbortSignal): Promise<string>;
}

export type AnswerGenerationEvent =
  | { type: "answer_start"; answerId: string; questionId: string; mode: AnswerMode; model: string }
  | { type: "answer_delta"; answerId: string; delta: string }
  | { type: "claim_gate_pass"; answerId: string; elapsedMs: number }
  | { type: "answer_end"; answerId: string; text: string; quality?: AnswerQualityResult };

export interface AnswerGenerationOptions {
  hasScreenshot?: boolean;
  attachments?: Array<{ mimeType: string; dataUrl: string }>;
  maxOutputTokens?: number;
  instruction?: string;
  /** Keep the provider stream internal and emit only the final answer. */
  directDisplay?: boolean;
  /** Whether answer_delta events should be exposed to the UI. */
  emitDeltas?: boolean;
  /** Enables bounded coverage/depth repair when the answer is buffered. */
  allowQualityRepair?: boolean;
  /** Preserve the model's completed text instead of rewriting it after generation. */
  formatAnswer?: boolean;
  /** Per-request retry override for latency-sensitive calls. */
  maxRetries?: number;
  /** Use the configured fast route for ordinary automatic interview questions. */
  preferFastRoute?: boolean;
  /** Freeze a model routing snapshot for a running interview session. */
  modelOverride?: ModelSnapshot;
  /** Never expose an unsupported personal/project claim as a final answer. */
  strictPersonalGrounding?: boolean;
}

class StreamingSentenceClaimGate {
  private pending = "";
  private elapsed = 0;
  private readonly projectTruthGuard = new ProjectTruthGuard();

  constructor(private readonly input: { question: string; evidenceSnapshot: EvidenceSnapshot; intent: ReturnType<typeof analyzeAnswerIntent> }) {}

  get elapsedMs(): number { return this.elapsed; }

  push(text: string): string {
    if (!text) return "";
    this.pending += text;
    let output = "";
    let boundary = this.pending.search(/[。！？!?；;\n]/u);
    while (boundary >= 0) {
      const sentence = this.pending.slice(0, boundary + 1);
      this.pending = this.pending.slice(boundary + 1);
      output += this.check(sentence);
      boundary = this.pending.search(/[。！？!?；;\n]/u);
    }
    return output;
  }

  finish(): string {
    const remaining = this.pending;
    this.pending = "";
    return remaining ? this.check(remaining) : "";
  }

  private check(sentence: string): string {
    const startedAt = performance.now();
    // Evaluate the sentence itself when possible. The full snapshot remains
    // authoritative, while sentence-level checks make unsupported ownership
    // claims safe without blocking the rest of the stream.
    const sentenceResult = new ClaimGate().check({ ...this.input, answer: sentence });
    if (sentenceResult.decision === "abstain") {
      this.elapsed += Math.max(0, performance.now() - startedAt);
      return "";
    }
    const candidate = sentenceResult.decision === "allow" ? sentence : sentenceResult.rewrittenAnswer ?? "";
    const truthResult = this.projectTruthGuard.check({ answer: candidate, evidenceSnapshot: this.input.evidenceSnapshot });
    this.elapsed += Math.max(0, performance.now() - startedAt);
    if (truthResult.decision === "BLOCK") return "";
    return stripClaimGateAuditText(truthResult.answer);
  }
}

export class AnswerAgent {
  constructor(
    private readonly providers: Partial<Record<ModelRoute, AnswerProvider>>,
    private readonly modelRouter = new ModelRouter({}, "configured-default"),
    private readonly contextRouter = new ContextRouter(),
    private readonly promptBuilder = new PromptBuilder(),
    private readonly formatter = new SpokenAnswerFormatter(),
    private readonly qualityChecker = new AnswerQualityChecker(),
    private readonly answerPlanner = new AnswerPlanner(),
    private readonly spokenQualityChecker = new SpokenQualityChecker(),
    private readonly coverageChecker = new AnswerPlanCoverageChecker()
  ) {}

  getModelSnapshot(): ModelSnapshot { return this.modelRouter.snapshot(); }

  async *stream(question: AnswerQuestion, mode: AnswerMode, contextInput: AnswerContextInput = {}, signal?: AbortSignal, options: AnswerGenerationOptions = {}): AsyncGenerator<AnswerGenerationEvent> {
    const routedQuestion = { ...question, text: normalizeTechnicalTerms(question.text) };
    const routedContext = this.contextRouter.route(routedQuestion.text, contextInput);
    const evidenceSnapshot = routedContext.evidenceSnapshot ?? createEvidenceSnapshot({
      questionId: routedQuestion.id,
      profileSummary: routedContext.profileSummary,
      jobDescriptionSummary: routedContext.jobDescriptionSummary,
      profileInstructions: routedContext.profileInstructions,
      currentProject: routedContext.currentProject,
      currentModule: routedContext.currentModule,
      currentTopic: routedContext.currentTopic ?? routedContext.interviewMemory?.currentTopic,
      personalMemoryEvidence: routedContext.personalMemoryEvidence,
      experienceContext: routedContext.experienceContext,
      projectEvidence: routedContext.projectEvidence,
      verifiedResumeEvidence: routedContext.verifiedResumeEvidence,
      verifiedPersonalProjectFacts: routedContext.verifiedPersonalProjectFacts,
      retrievedKnowledge: routedContext.retrievedKnowledge,
      answerSourcePlan: routedContext.answerSourcePlan,
      projectQaEvidence: routedContext.projectQaEvidence,
      recentTranscript: routedContext.recentTranscript,
      interviewMemory: routedContext.interviewMemory,
      sessionEvidence: routedContext.sessionEvidence,
      candidateStatements: routedContext.candidateStatements
    });
    const context = { ...routedContext, evidenceSnapshot };
    if (context.coreTechnicalQa && (!context.answerSourcePlan || context.answerSourcePlan.mode === "general_technical") && !context.answerSourcePlan?.projectQuestionRequested) {
      context.answerSourcePlan = planAnswerSource({ coreTechnicalQa: context.coreTechnicalQa });
    }
    const kind = classifyAnswerQuestion(routedQuestion.text, routedQuestion.kind);
    const plan = this.answerPlanner.plan({
      question: routedQuestion.text,
      questionType: kind,
      currentProject: context.currentProject,
      currentTopic: context.currentTopic ?? context.interviewMemory?.currentTopic,
      currentModule: context.currentModule,
      followUpContext: context.followUpContext,
      recentTranscript: context.recentTranscript,
      projectEvidence: context.projectEvidence,
      retrievedKnowledge: context.retrievedKnowledge,
      preparedAnswer: context.preparedAnswer,
      questionBankContext: context.questionBankMatches,
      interviewMode: mode
    });
    const intent = plan.intent;
    let selection = this.modelRouter.select(routedQuestion.text, mode, options.hasScreenshot ?? false, options.modelOverride);
    if (options.preferFastRoute && kind !== "code" && !(options.hasScreenshot ?? false)) {
      const fastSelection = this.modelRouter.select(routedQuestion.text, "FAST", false, options.modelOverride);
      if (fastSelection.model) selection = fastSelection;
    }
    if (!selection.model) throw new Error(`No model configured for ${selection.route}`);
    const provider = this.providers[selection.route] ?? (selection.route === "normal" ? this.providers["low-latency"] : undefined);
    if (!provider) throw new Error(`No AnswerProvider configured for ${selection.route}`);
    const answerId = `answer-${Date.now()}-${question.id}`;
    const sections = this.promptBuilder.build(routedQuestion, mode, context, plan);
    if (options.instruction?.trim()) sections.push({ name: "output-format", content: options.instruction.trim() });
    yield { type: "answer_start", answerId, questionId: routedQuestion.id, mode, model: selection.model };
    const providerRequest: AnswerProviderRequest = {
      model: selection.model,
      sections,
      attachments: options.attachments,
      thinking: mode === "DEEP",
       maxOutputTokens: options.maxOutputTokens ?? answerTokenBudget(mode, kind, plan),
      maxRetries: options.maxRetries
    };
    let text = "";
    let streamedSafeText = "";
    let sanitizedStreamText = "";
    let claimGateFirstPassEmitted = false;
    const sanitizer = new StreamingAnswerSanitizer();
    const personalClaimRequested = requiresPersonalClaimEvidence(intent) || intent.asksBehavioralEpisode;
    const projectContextRequested = intent.asksProjectImplementation || intent.allowsProjectEvidence;
    const streamingClaimGate = !options.directDisplay && (personalClaimRequested || projectContextRequested)
      ? new StreamingSentenceClaimGate({ question: routedQuestion.text, evidenceSnapshot, intent })
      : undefined;
    const emitSafeDelta = (delta: string): void => {
      if (!delta) return;
      const safe = streamingClaimGate ? streamingClaimGate.push(delta) : delta;
      if (safe) streamedSafeText += safe;
    };
    if (options.directDisplay && provider.complete) {
      text = await provider.complete(providerRequest, signal);
    } else {
      for await (const delta of provider.stream(providerRequest, signal)) {
        if (!delta) continue;
        text += delta;
        const safeDelta = sanitizer.push(delta);
        if (options.emitDeltas !== false && !options.directDisplay && safeDelta) {
          const before = streamedSafeText;
          emitSafeDelta(safeDelta);
          const emitted = streamedSafeText.slice(before.length);
          if (emitted) {
            if (streamingClaimGate && !claimGateFirstPassEmitted) {
              claimGateFirstPassEmitted = true;
              yield { type: "claim_gate_pass", answerId, elapsedMs: streamingClaimGate.elapsedMs };
            }
            yield { type: "answer_delta", answerId, delta: emitted };
          }
          sanitizedStreamText += safeDelta;
        }
      }
      if (options.emitDeltas !== false && !options.directDisplay) {
        const finalized = sanitizer.finalize();
        const remainder = finalized.startsWith(sanitizedStreamText) ? finalized.slice(sanitizedStreamText.length) : "";
        if (remainder) {
          const before = streamedSafeText;
          emitSafeDelta(remainder);
          const emitted = streamedSafeText.slice(before.length);
          if (emitted) {
            if (streamingClaimGate && !claimGateFirstPassEmitted) {
              claimGateFirstPassEmitted = true;
              yield { type: "claim_gate_pass", answerId, elapsedMs: streamingClaimGate.elapsedMs };
            }
            yield { type: "answer_delta", answerId, delta: emitted };
          }
        }
        const trailing = streamingClaimGate?.finish() ?? "";
        if (trailing) {
          streamedSafeText += trailing;
          if (streamingClaimGate && !claimGateFirstPassEmitted) {
            claimGateFirstPassEmitted = true;
            yield { type: "claim_gate_pass", answerId, elapsedMs: streamingClaimGate.elapsedMs };
          }
          yield { type: "answer_delta", answerId, delta: trailing };
        }
      }
    }
    const completedText = options.directDisplay && provider.complete ? sanitizeStreamingAnswer(text) : options.emitDeltas !== false && !options.directDisplay ? streamedSafeText : sanitizer.finalize();
    let formattedText = options.formatAnswer === false ? completedText.trim() : this.formatter.format(completedText, mode, kind, plan);
    const explicitlyProvidedExperience = context.personalMemoryEvidence.length > 0 || context.experienceContext.length > 0 || context.projectEvidence.length > 0;
    const groundingText = [
      ...(personalClaimRequested || projectContextRequested || explicitlyProvidedExperience || context.projectQaEvidence.length > 0 ? [context.profileSummary, context.jobDescriptionSummary, ...context.sessionEvidence.map((item) => item.text), ...context.personalMemoryEvidence, ...context.experienceContext, ...context.verifiedResumeEvidence, ...context.verifiedPersonalProjectFacts, ...context.projectQaEvidence, ...context.projectEvidence] : []),
      ...context.skills.map((skill) => skill.content),
      ...context.retrievedKnowledge
    ].filter(Boolean).join("\n");
    const personalAnswerValidator = new PersonalAnswerValidator();
    const personalQuestionAnalysis = new QuestionAnalyzer().analyze(routedQuestion.text);
    let coverage: AnswerCoverageResult = this.coverageChecker.check(plan, formattedText);
    let repairApplied = false;
    const evaluateQuality = (answer: string): AnswerQualityResult => {
      coverage = this.coverageChecker.check(plan, answer);
      let result = this.qualityChecker.check({ question: routedQuestion.text, answer, mode, kind, groundingText, coverage });
      const spoken = this.spokenQualityChecker.check({ question: routedQuestion.text, answer, mode, kind, plan, projectEvidence: [...context.projectEvidence, ...context.projectQaEvidence], groundingText });
      result = {
        ...result,
        score: Math.min(result.score, spoken.score),
        issues: [...new Set([...result.issues, ...spoken.issues])],
        suggestions: [...new Set([...result.suggestions, ...spoken.suggestions])],
        needsRepair: result.needsRepair || spoken.needsRepair,
        coverage
      };
      const personalEvidence = [
        ...context.sessionEvidence.map((item) => item.text),
        ...context.personalMemoryEvidence,
        ...context.experienceContext,
        ...context.verifiedResumeEvidence,
        ...context.verifiedPersonalProjectFacts,
        ...context.projectQaEvidence
      ];
      if (personalClaimRequested && personalEvidence.length > 0) {
        const validation = personalAnswerValidator.validate({
          question: routedQuestion.text,
          answer,
          analysis: personalQuestionAnalysis,
          evidence: personalEvidence
        });
        result = {
          ...result,
          score: Math.min(result.score, validation.score),
          issues: [...result.issues, ...validation.issues],
          suggestions: [...result.suggestions, ...validation.suggestions],
          needsRepair: result.needsRepair || !validation.valid
        };
      }
      return { ...result, coverage };
    };
    let quality = evaluateQuality(formattedText);
    const initialAnswerCharacterCount = coverage.characterCount;
    // A depth repair is a bounded supplement, not a second full answer. It is
    // deliberately performed after coverage inspection so longer output has
    // to add missing technical content instead of padding with filler.
    const qualityRepairEnabled = options.allowQualityRepair !== false && options.emitDeltas !== true;
    if (qualityRepairEnabled && mode !== "FAST" && !options.strictPersonalGrounding && !groundingText.trim() && coverage.needsRepair && coverage.missingFacets.length > 0 && coverage.characterCount < plan.length.maxCharacters) {
      const depthRepair = new AnswerDepthRepair({
        generate: async (instruction) => {
          let repaired = "";
          for await (const delta of provider.stream({
            model: selection.model,
            sections: [...sections, { name: "output-format", content: instruction }],
            attachments: options.attachments,
            thinking: mode === "DEEP",
            maxOutputTokens: Math.min(768, Math.max(192, Math.ceil((plan.length.maxCharacters - coverage.characterCount) / 1.5))),
            maxRetries: options.maxRetries
          }, signal)) repaired += delta;
          return repaired;
        }
      });
      const supplement = this.formatter.format(await depthRepair.repair({ question: routedQuestion.text, existingAnswer: formattedText, missingFacets: coverage.missingFacets, targetCharacters: plan.length.targetCharacters, plan, evidenceText: groundingText }), mode, kind, plan);
      if (supplement.trim()) {
        const combined = `${formattedText.trim()}\n${supplement.trim()}`.trim();
        const combinedCoverage = this.coverageChecker.check(plan, combined);
        if (combined.length <= plan.length.maxCharacters && (combinedCoverage.coveredFacets.length > coverage.coveredFacets.length || combinedCoverage.characterCount > coverage.characterCount)) {
          formattedText = combined;
          repairApplied = true;
          quality = evaluateQuality(formattedText);
          if (!options.directDisplay && options.emitDeltas !== false) yield { type: "answer_delta", answerId, delta: `\n${supplement.trim()}` };
        }
      }
    }
    // Repair only when grounded profile material exists. This keeps the
    // realtime path low-latency for generic answers while preventing a
    // clearly poor or ungrounded answer from being shown as final.
    const repairableFormatIssue = quality.issues.some((issue) => [
      "answer-too-short",
      "answer-too-long",
      "too-formal",
      "question-mismatch",
      "not-first-person"
    ].includes(issue));
    if (qualityRepairEnabled && quality.needsRepair && (groundingText.trim() || repairableFormatIssue)) {
      const repairInstruction = [
        "这是同一个面试问题的答案修正，不是新问题。只输出修正后的最终答案。",
        `原始问题：${routedQuestion.text}`,
        `上一版答案 A：\n${formattedText || "（上一版为空）"}`,
        `检测到的质量问题：${quality.issues.length > 0 ? quality.issues.join("、") : "未命名问题"}`,
        `修改建议：${quality.suggestions.length > 0 ? quality.suggestions.join("；") : "直接回答问题并保持信息完整"}`,
        `可使用的 grounding evidence（只能使用这些事实）：\n${groundingText || "无；不得新增任何个人经历、数字、芯片型号、职责或结果"}`,
        personalClaimRequested
          ? "个人经历必须使用候选人第一人称；证据中没有的内容明确说资料不足，不能补写。"
          : "不要强行添加项目经历；保留技术结论、完整代码和必要解释。",
        "修正后重新检查：第一句回应原始问题，删除无证据的个人断言，不要输出修正过程或资料标签。"
      ].join("\n");
      let repaired = "";
      for await (const delta of provider.stream({
        model: selection.model,
        sections: [
          ...sections,
          ...(groundingText.trim() ? [{ name: "experience-context" as const, content: `修正时可引用的 grounding evidence：\n${groundingText}` }] : []),
          { name: "output-format", content: repairInstruction }
        ],
        attachments: options.attachments,
        thinking: mode === "DEEP",
         maxOutputTokens: options.maxOutputTokens ?? answerTokenBudget(mode, kind, plan),
        maxRetries: options.maxRetries
      }, signal)) repaired += delta;
      const repairedText = this.formatter.format(repaired, mode, kind, plan);
      const repairedQuality = evaluateQuality(repairedText);
      if (repairedText.trim() && repairedQuality.score >= quality.score) {
        formattedText = repairedText;
        quality = repairedQuality;
      }
    }
    const technicalAccuracy = new TechnicalAccuracyGuard().check({ question: routedQuestion.text, answer: formattedText });
    if (technicalAccuracy.decision === "rewrite" && technicalAccuracy.rewrittenAnswer) {
      formattedText = technicalAccuracy.rewrittenAnswer;
      quality = {
        ...evaluateQuality(formattedText),
        issues: [...new Set([...quality.issues, ...technicalAccuracy.issues.map((issue) => `technical-accuracy-${issue}`)])],
        suggestions: quality.suggestions,
        needsRepair: false
      };
    }
    const hrPolicy = enforceHrProfilePolicy({ question: routedQuestion.text, answer: formattedText, companyContext: context.companyContext, salaryExpectation: context.salaryExpectation });
    if (hrPolicy.rewritten) formattedText = hrPolicy.answer;
    const claimGate = new ClaimGate().check({
      question: routedQuestion.text,
      answer: formattedText,
      evidenceSnapshot,
      intent
    });
    if (claimGate.decision !== "allow") {
      formattedText = stripClaimGateAuditText(claimGate.rewrittenAnswer ?? "");
      quality = {
        ...quality,
        score: Math.min(quality.score, claimGate.score),
        issues: [...new Set([...quality.issues, ...claimGate.issues, `claim-gate-${claimGate.decision}`])],
        suggestions: [...new Set([...quality.suggestions, ...claimGate.suggestions])],
        needsRepair: false
      };
    }
    const projectTruth = new ProjectTruthGuard().check({ answer: formattedText, evidenceSnapshot });
    if (projectTruth.decision !== "ALLOW") {
      formattedText = stripClaimGateAuditText(projectTruth.answer);
      quality = {
        ...quality,
        score: projectTruth.decision === "BLOCK" ? 0 : Math.min(quality.score, 0.75),
        issues: [...new Set([...quality.issues, `project-truth-${projectTruth.decision.toLowerCase()}`, ...projectTruth.findings.filter((finding) => finding.status === "CONTRADICTED").map(() => "project-truth-contradicted")])],
        suggestions: [...quality.suggestions, projectTruth.reason],
        needsRepair: false
      };
    }
    formattedText = stripClaimGateAuditText(formattedText);
    quality = {
      ...quality,
      claimGateDecision: claimGate.decision,
      blockedClaimCount: claimGate.blockedClaims.length,
      ...(context.answerSourcePlan ? { answerSourceMode: context.answerSourcePlan.mode, qaMatchLevel: context.answerSourcePlan.qaMatchLevel } : {})
    };
    quality.telemetry = {
      ...(context.questionTelemetry ?? {}),
      normalizedText: context.questionTelemetry?.normalizedText ?? routedQuestion.text,
      canonicalText: context.questionTelemetry?.canonicalText ?? routedQuestion.text,
      answerSourceMode: context.answerSourcePlan?.mode ?? context.questionTelemetry?.answerSourceMode,
      coreQaQuestionId: context.coreTechnicalQa?.id ?? context.questionTelemetry?.coreQaQuestionId,
      coreQaMatchLevel: context.coreTechnicalQa ? "verified" : context.questionTelemetry?.coreQaMatchLevel,
      technicalGuardDecision: technicalAccuracy.decision,
      technicalGuardIssues: technicalAccuracy.issues,
      technicalViolationCount: technicalAccuracy.violationCount,
      claimGateDecision: claimGate.decision,
      blockedPersonalClaimCount: claimGate.blockedClaims.length,
      blockedClaimTypes: [...new Set(claimGate.blockedClaims.map((claim) => claim.type))],
      unsupportedPastPersonalActionCount: claimGate.unsupportedPastPersonalActionCount,
      claimGateMs: streamingClaimGate?.elapsedMs,
      projectFactCount: context.projectEvidence.length + context.projectQaEvidence.length + context.verifiedPersonalProjectFacts.length,
      sessionEvidenceCount: context.sessionEvidence.length,
      topic: context.currentTopic ?? context.interviewMemory?.currentTopic,
      questionRelation: context.followUpContext ? "FOLLOW_UP" : "NEW_TOPIC",
      projectQaMatch: context.answerSourcePlan?.qaMatchLevel,
      ...(context.answerSourcePlan?.qaMatch?.questionId ? { projectQaQuestionId: context.answerSourcePlan.qaMatch.questionId } : {})
    };
     quality.projectTruthDecision = projectTruth.decision;
     quality.coverage = this.coverageChecker.check(plan, formattedText);
     quality.coverage = { ...quality.coverage };
     if (repairApplied) quality.issues = [...new Set([...quality.issues, "answer-depth-repair-applied"])];
      // Keep the final coverage verdict truthful. A repair attempt may be
      // rejected by the max-length or grounding guards, so it must not turn
      // an incomplete answer into a false “passed” result.
     // Once a safety gate has rewritten or removed unsupported personal facts,
     // do not report the pre-gate depth deficit as another generation failure.
     // There is intentionally no safe evidence with which to deepen that
     // personal answer; the gate's sanitized result is the terminal output.
     quality.needsRepair = quality.coverage.needsRepair
       && claimGate.decision === "allow"
       && projectTruth.decision === "ALLOW";
     quality.telemetry = {
       ...quality.telemetry,
       coveredFacets: quality.coverage.coveredFacets,
       missingFacets: quality.coverage.missingFacets,
       answerCharacterCount: quality.coverage.characterCount,
       requiredFacets: quality.coverage.requiredFacets,
       answerEstimatedDurationSec: quality.coverage.estimatedDurationSec,
       answerDepthPass: quality.coverage.depthPass,
       answerRepairApplied: repairApplied
     };
     quality.telemetry = {
       ...quality.telemetry,
       initialAnswerCharacterCount,
       finalAnswerCharacterCount: quality.coverage.characterCount,
       answerRuntimeTrace: {
         questionId: routedQuestion.id,
         answerId,
         sourceMode: context.answerSourcePlan?.mode,
         requiredFacets: quality.coverage.requiredFacets,
         coveredFacets: quality.coverage.coveredFacets,
         missingFacets: quality.coverage.missingFacets,
         initialCharacterCount: initialAnswerCharacterCount,
         finalCharacterCount: quality.coverage.characterCount,
         estimatedDurationSec: quality.coverage.estimatedDurationSec,
         depthPass: quality.coverage.depthPass,
         needsRepair: quality.needsRepair,
         repairApplied
       }
     };
    quality.blockedClaimCount = Math.max(claimGate.blockedClaims.length, projectTruth.blockedClaimCount);
    quality.telemetry = { ...quality.telemetry, blockedClaimCount: projectTruth.blockedClaimCount, projectTruthDecision: projectTruth.decision };
    yield { type: "answer_end", answerId, text: formattedText, quality };
  }
}

export interface StableAnswerSnapshot {
  displayedText: string;
  displayedAnswerId?: string;
  pendingAnswerId?: string;
  pendingText: string;
  streaming: boolean;
  /** Compatibility state for legacy consumers; visible answers are never removed. */
  visibleAnswers: Array<{ answerId: string; text: string }>;
}

export class StableAnswerStateMachine {
  private value: StableAnswerSnapshot = { displayedText: "", pendingText: "", streaming: false, visibleAnswers: [] };

  get snapshot(): StableAnswerSnapshot { return { ...this.value, visibleAnswers: this.value.visibleAnswers.map((answer) => ({ ...answer })) }; }

  reset(): StableAnswerSnapshot {
    this.value = { displayedText: "", pendingText: "", streaming: false, visibleAnswers: [] };
    return this.snapshot;
  }

  start(answerId: string): StableAnswerSnapshot {
    // Keep answer A visible while answer B is still speculative. A replacement
    // becomes visible only after its first non-empty delta arrives.
    this.value = {
      displayedText: this.value.displayedText,
      displayedAnswerId: this.value.displayedAnswerId,
      pendingAnswerId: answerId,
      pendingText: "",
      streaming: true,
      visibleAnswers: this.value.visibleAnswers
    };
    return this.snapshot;
  }

  delta(answerId: string, delta: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId || !delta) return this.snapshot;
    const pendingText = this.value.pendingText + delta;
    const visibleAnswers = this.value.visibleAnswers.some((answer) => answer.answerId === answerId)
      ? this.value.visibleAnswers.map((answer) => answer.answerId === answerId ? { ...answer, text: pendingText } : answer)
      : [...this.value.visibleAnswers, { answerId, text: pendingText }];
    this.value = {
      ...this.value,
      pendingText,
      displayedText: pendingText,
      displayedAnswerId: answerId,
      visibleAnswers
    };
    return this.snapshot;
  }

  end(answerId: string, text: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId) return this.snapshot;
    const finalText = text || this.value.pendingText;
    if (!finalText) {
      this.value = { ...this.value, pendingAnswerId: undefined, pendingText: "", streaming: false };
      return this.snapshot;
    }
    const visibleAnswers = this.value.visibleAnswers.some((answer) => answer.answerId === answerId)
      ? this.value.visibleAnswers.map((answer) => answer.answerId === answerId ? { ...answer, text: finalText } : answer)
      : [...this.value.visibleAnswers, { answerId, text: finalText }];
    this.value = { displayedText: finalText, displayedAnswerId: answerId, pendingText: "", streaming: false, visibleAnswers };
    return this.snapshot;
  }

  cancel(answerId: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId) return this.snapshot;
    this.value = { ...this.value, pendingAnswerId: undefined, pendingText: "", streaming: false };
    return this.snapshot;
  }
}
