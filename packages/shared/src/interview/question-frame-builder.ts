import { ProjectAliasResolver, type ProjectAliasCandidate } from "../project-alias-resolver";
import { normalizeTechnicalTerms } from "../terminology";
import { decomposeQuestion, type QuestionSlot } from "../question/question-decomposer";
import type { ConversationAnchorSnapshot } from "./conversation-anchor-state";
import { SemanticQuestionCompletion } from "./semantic-question-completion";
import { classifySpeechActV3 } from "./speech-act-v3";
import { ContextualQuestionRewriter, type ContextualQuestionRewriteResult } from "./contextual-question-rewriter";
import { resolveContextualQuestion } from "./contextual-question-resolution";
import { buildQuestionRequirements } from "./question-requirements";
import { isTopicOnlyFragment, spokenEntities } from "./question-subject";
import type { ActiveProjectContext, EntityAnchor, QuestionContextSnapshot, QuestionFrame, QuestionFrameRelation, QuestionFrameType, ReferenceCandidate } from "./question-frame";

export interface QuestionFrameBuildInput {
  id: string;
  sessionId?: string;
  segmentIds?: string[];
  rawSegments?: string[];
  rawText: string;
  final: boolean;
  timestamp?: number;
  speaker?: "interviewer" | "candidate";
  asrConfidence?: number;
  anchors: ConversationAnchorSnapshot;
  activeProject?: ActiveProjectContext;
  previousAnswer?: string;
  projectCandidates?: readonly ProjectAliasCandidate[];
  now?: number;
}

export interface QuestionFrameBuildResult {
  frame: QuestionFrame;
  rewrite: ContextualQuestionRewriteResult;
}

const COMPONENTS = /(?:STM\d+[A-Z0-9]*|F405|MCU|芯片|控制器|编码器|传感器|栈|stack)/iu;
const TECHNOLOGIES = /(?:DMA|ADC|PWM|CAN|UART|IIC|I2C|SPI|FOC|RTOS|FreeRTOS|Linux|Cortex-[MAR]|C\+\+)/iu;
const CONCEPTS = /(?:中断|interrupt|exception|采样|实时性|缓存|队列|模式|原理|线程|指针|数组|内存)/iu;
const REFERENCE_WORD = /(?:它|这个|那个|这个项目|该项目|这个芯片|这个模式|这种方式|这样|刚才那个|前面那个|多久|为什么这么做|那这个呢)/giu;
const PROJECT_CUE = /(?:项目|平台|系统|方案|架构|项目里|项目中|你这个|你们的|简历|实际实现)/iu;

function clean(value: string): string { return normalizeTechnicalTerms(value).replace(/\s+/g, " ").trim(); }
function compact(value: string): string { return value.replace(/[\s，。！？?！、；;：:]/gu, "").toLowerCase(); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function join(values: string[]): string {
  return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ").replace(/\s+([，。！？?！；;：:])/gu, "$1").trim();
}

function extractEntities(text: string, now: number, anchors: ConversationAnchorSnapshot): { entities: QuestionFrame["entities"]; anchors: EntityAnchor[] } {
  const values = spokenEntities(text);
  const componentValues = values.filter((value) => COMPONENTS.test(value));
  const technologyValues = values.filter((value) => TECHNOLOGIES.test(value));
  const conceptValues = values.filter((value) => CONCEPTS.test(value));
  const entities: QuestionFrame["entities"] = { projects: anchors.activeProject ? [anchors.activeProject.id, anchors.activeProject.name] : [], components: unique(componentValues), technologies: unique(technologyValues), concepts: unique(conceptValues) };
  const entityAnchors: EntityAnchor[] = [
    ...entities.components.map((value) => ({ value, type: "component" as const, confidence: 0.96, source: "question-frame", createdAt: now })),
    ...entities.technologies.map((value) => ({ value, type: "technology" as const, confidence: 0.96, source: "question-frame", createdAt: now })),
    ...entities.concepts.map((value) => ({ value, type: "concept" as const, confidence: 0.9, source: "question-frame", createdAt: now }))
  ];
  return { entities, anchors: entityAnchors };
}

function resolveProject(text: string, input: QuestionFrameBuildInput): { project?: ActiveProjectContext; confidence: number } {
  if (!PROJECT_CUE.test(text) && spokenEntities(text).length && /(?:什么|怎么|如何|区别|原理|作用)/u.test(text)) {
    return input.activeProject ? { project: input.activeProject, confidence: input.activeProject.confidence } : { confidence: 0 };
  }
  if (input.projectCandidates?.length) {
    const resolution = new ProjectAliasResolver().resolve(text, input.projectCandidates);
    if (resolution.projectId && !resolution.ambiguous) {
      const candidate = input.projectCandidates.find((item) => item.id === resolution.projectId);
      if (candidate) return { project: { id: candidate.id, name: candidate.name, lockState: resolution.confidence >= 0.96 ? "LOCKED" : "CANDIDATE", confidence: resolution.confidence, entities: [...(candidate.entities ?? [])], topics: [...(candidate.aliases ?? [])], source: "interviewer" }, confidence: resolution.confidence };
    }
  }
  if (input.activeProject) return { project: input.activeProject, confidence: input.activeProject.confidence };
  if (!input.projectCandidates?.length) return { confidence: 0 };
  const resolution = new ProjectAliasResolver().resolve(text, input.projectCandidates);
  if (!resolution.projectId || resolution.ambiguous) return { confidence: resolution.confidence };
  const candidate = input.projectCandidates.find((item) => item.id === resolution.projectId);
  return candidate ? { project: { id: candidate.id, name: candidate.name, lockState: resolution.confidence >= 0.96 ? "LOCKED" : "CANDIDATE", confidence: resolution.confidence, entities: [...(candidate.entities ?? [])], topics: [...(candidate.aliases ?? [])], source: "interviewer" }, confidence: resolution.confidence } : { confidence: resolution.confidence };
}

function referencesFor(text: string, anchors: ConversationAnchorSnapshot, entities: QuestionFrame["entities"]): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = [];
  for (const raw of text.match(REFERENCE_WORD) ?? []) {
    let resolved: string | undefined;
    let type: ReferenceCandidate["type"];
    if (/这个项目|该项目/u.test(raw)) { resolved = anchors.activeProject?.id; type = "project"; }
    else if (/这个芯片/u.test(raw)) { resolved = entities.components[0] ?? anchors.activeComponent?.value; type = "component"; }
    else if (/这个模式|这种方式/u.test(raw)) { resolved = anchors.activeConcept?.value ?? anchors.lastQuestion?.entities.concepts[0]; type = resolved ? "concept" : undefined; }
    else if (/它|那个|这个|刚才|前面|多久|为什么这么做|那这个/u.test(raw)) {
      resolved = entities.components[0] ?? entities.technologies[0] ?? anchors.activeComponent?.value ?? anchors.activeTechnology?.value ?? anchors.lastQuestion?.canonicalQuestion;
      type = resolved ? (resolved === anchors.lastQuestion?.canonicalQuestion ? "question" : "technology") : undefined;
    }
    references.push({ raw, ...(resolved ? { resolved } : {}), ...(type ? { type } : {}), confidence: resolved ? 0.94 : 0.35, evidence: resolved ? ["active-anchor-or-question-entity"] : ["no-active-anchor"] });
  }
  return references;
}

function canonicalQuestion(text: string, project: ActiveProjectContext | undefined, entities: QuestionFrame["entities"]): string {
  const value = clean(text).replace(/^(?:第一个问题|第一个问题，|那你讲一下|请你讲一下)\s*/iu, (match) => /那你讲一下/iu.test(match) ? "那你讲一下 " : "");
  const stackQuestion = value.search(/哪个栈[？?。！!]?/iu);
  if (stackQuestion > 0 && /(?:interrupt|exception|stack|nesting|hardware stacking|中断|异常|嵌套|硬件压栈)/iu.test(value.slice(0, stackQuestion))) return value.slice(stackQuestion).replace(/(?:。|！|!)+$/gu, "") || "哪个栈？";
  if (/(?:为什么(?:要)?选|为什么(?:要)?选择)/iu.test(value) && entities.components.some((item) => /STM32F405|F405/iu.test(item))) return `为什么在 ${project?.name ?? "这个 FOC / 电机控制"}项目中选择 STM32F405？选型时主要考虑了哪些因素？`;
  if (/(?:多久触发一次|触发多久)/iu.test(value) && entities.technologies.some((item) => /ADC/iu.test(item))) return "ADC 采样多久触发一次？";
  return value.replace(/\s+/g, " ").trim().replace(/(?:。|！|!)+$/gu, "") + (/[？?]$/u.test(value) ? "" : /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪个|吗|呢|选|选择|工作)/iu.test(value) ? "？" : "");
}

function slotsFor(text: string, type: QuestionFrameType): QuestionSlot[] {
  if (type === "PROJECT" && /DMA/iu.test(text) && /(?:项目里|项目中|怎么用|什么模式)/iu.test(text)) {
    const values = ["DMA 在项目哪里使用", "数据流是什么", "DMA 模式是什么"];
    return values.map((question, index) => ({ index: index + 1, question, intent: index === 2 ? "how" : "project", semanticFrame: "implementation", evidenceScope: "project", required: true }));
  }
  return decomposeQuestion(text).slots;
}

function intentFor(text: string): string {
  if (/区别|差异|对比|取舍/iu.test(text)) return "DIFFERENCE";
  if (/为什么|为何|原因/iu.test(text)) return "TRADEOFF";
  if (/怎么排查|如何定位|故障/iu.test(text)) return "DEBUGGING";
  if (/怎么用|如何用|怎么做|如何做|实现|模式/iu.test(text)) return "IMPLEMENTATION";
  if (/原理|怎么工作|如何工作/iu.test(text)) return "PRINCIPLE";
  if (/多少|几个|哪些/iu.test(text)) return "ENUMERATION";
  return "DEFINITION";
}

export class QuestionFrameBuilder {
  private readonly rewriter = new ContextualQuestionRewriter();
  private readonly completion = new SemanticQuestionCompletion();

  build(input: QuestionFrameBuildInput): QuestionFrameBuildResult {
    const now = input.now ?? input.timestamp ?? Date.now();
    const rawSegments = input.rawSegments?.length ? input.rawSegments.map((value) => value.trim()).filter(Boolean) : [input.rawText.trim()];
    const rawCombinedText = join(rawSegments);
    const rewrite = this.rewriter.rewrite({ rawText: rawCombinedText, currentTopic: input.anchors.currentTopic?.name, previousQuestion: input.anchors.lastQuestion?.canonicalQuestion, activeProject: input.activeProject, activeEntities: input.anchors.entities });
    const resolvedProject = resolveProject(rewrite.normalizedText, input);
    const entityResult = extractEntities(rewrite.normalizedText, now, { ...input.anchors, ...(resolvedProject.project ? { activeProject: resolvedProject.project } : {}) });
    const contextResolution = resolveContextualQuestion({ rawText: rawCombinedText, normalizedText: rewrite.normalizedText, currentTopic: input.anchors.currentTopic?.name, previousQuestion: input.anchors.lastQuestion?.canonicalQuestion, previousAnswer: input.previousAnswer, activeProject: resolvedProject.project ?? input.activeProject, activeEntities: [...input.anchors.entities, ...entityResult.anchors] });
    const speech = classifySpeechActV3(rewrite.normalizedText, Boolean(input.anchors.lastQuestion || input.anchors.currentTopic));
    const effectiveSpeechAct = rewrite.unresolved.length > 0 ? "ASR_UNRESOLVED" as const : speech.speechAct;
    const contextualReferences: ReferenceCandidate[] = contextResolution.references.map((reference) => ({ raw: reference.raw, resolved: reference.resolved, type: ["project", "component", "technology", "question"].includes(reference.type) ? reference.type as ReferenceCandidate["type"] : "concept", confidence: reference.confidence, evidence: ["context-resolution", reference.type] }));
    const references = [...referencesFor(contextResolution.canonicalQuestion, input.anchors, entityResult.entities), ...contextualReferences].filter((reference, index, all) => index === all.findIndex((candidate) => candidate.raw === reference.raw && candidate.resolved === reference.resolved));
    const textHasSubject = spokenEntities(contextResolution.canonicalQuestion).length > 0 || Boolean(resolvedProject.project) || PROJECT_CUE.test(contextResolution.canonicalQuestion) || /自我介绍|你.*(?:问题|了解)|岗位|工作|团队|专业|学校|实习|毕业/u.test(contextResolution.canonicalQuestion);
    const textHasObject = /(?:项目|系统|方案|模式|原因|区别|原理|作用|流程|方法|因素|工作|触发|采样|数据|芯片|平台|任务|栈|内核|中断|向量)/iu.test(contextResolution.canonicalQuestion) || entityResult.entities.components.length > 0 || entityResult.entities.technologies.length > 0;
    const questionType: QuestionFrameType = /(?:个人经历|简历|你做过|你的职责|你负责|面试经历)/iu.test(contextResolution.canonicalQuestion) ? "BEHAVIORAL" : resolvedProject.project && PROJECT_CUE.test(contextResolution.canonicalQuestion) ? "PROJECT" : /(?:项目|你这个平台|你这个系统|项目里|项目中)/iu.test(contextResolution.canonicalQuestion) ? "PROJECT" : /(?:自我介绍|简历)/iu.test(contextResolution.canonicalQuestion) ? "RESUME" : /(?:技术|原理|区别|怎么工作|如何工作|什么是|DMA|ADC|PWM|SPI|CAN|栈|中断|向量|内核)/iu.test(contextResolution.canonicalQuestion) ? "TECHNICAL" : "GENERAL";
    const slots = slotsFor(contextResolution.canonicalQuestion, questionType);
    const completion = this.completion.evaluate({ text: contextResolution.canonicalQuestion, speechAct: effectiveSpeechAct, references, unresolvedAsr: rewrite.unresolved.length > 0 || contextResolution.unresolved.length > 0 || effectiveSpeechAct === "ASR_UNRESOLVED", hasSubject: textHasSubject, hasObject: textHasObject, slotCount: slots.length, currentTopic: input.anchors.currentTopic?.name });
    const requirements = buildQuestionRequirements(contextResolution.canonicalQuestion, slots, questionType, resolvedProject.project?.id);
    const contextSnapshot: QuestionContextSnapshot = {
      id: `context-snapshot-${input.id}`,
      sessionId: input.sessionId ?? "interview-session",
      capturedAt: now,
      ...(resolvedProject.project ? { project: resolvedProject.project } : input.activeProject ? { project: input.activeProject } : {}),
      ...(input.anchors.currentTopic?.name ? { topic: input.anchors.currentTopic.name } : {}),
      activeEntities: [...input.anchors.entities, ...entityResult.anchors].map((item) => ({ ...item })),
      ...(input.anchors.lastQuestion ? { parentQuestion: { id: input.anchors.lastQuestion.id, text: input.anchors.lastQuestion.canonicalQuestion } } : {}),
      ...(input.anchors.lastQuestion ? { rootQuestion: { id: input.anchors.lastQuestion.id, text: input.anchors.lastQuestion.canonicalQuestion } } : {}),
      recentRelevantTurns: [input.previousAnswer, input.anchors.lastQuestion?.canonicalQuestion].filter((item): item is string => Boolean(item)).slice(-6),
      references: contextResolution.references.map((item) => ({ ...item })),
      inherited: { ...contextResolution.inherited }
    };
    const relation: QuestionFrameRelation = effectiveSpeechAct === "CLARIFICATION" ? "CLARIFICATION" : effectiveSpeechAct === "FOLLOW_UP" || references.length > 0 ? "FOLLOW_UP" : "NEW_TOPIC";
    const projectId = resolvedProject.project?.id;
    const asrConfidence = input.asrConfidence ?? (rewrite.unresolved.length ? 0.2 : rewrite.corrections.length ? 0.91 : 0.96);
    const referenceConfidence = references.length ? Math.min(...references.map((reference) => reference.confidence)) : 0.96;
    const overall = Math.min(speech.confidence, completion.confidence, Math.max(0, referenceConfidence), resolvedProject.confidence || 0.96, asrConfidence);
    const frame: QuestionFrame = {
      id: input.id,
      segmentIds: [...(input.segmentIds ?? [input.id])],
      rawSegments,
      rawCombinedText,
      normalizedText: rewrite.normalizedText,
      canonicalQuestion: contextResolution.canonicalQuestion || canonicalQuestion(rewrite.normalizedText, resolvedProject.project, entityResult.entities),
      speechAct: effectiveSpeechAct,
      completion: completion.state,
      stabilityState: input.final ? completion.state === "COMPLETE" ? "STABILIZING" : "UNRESOLVED" : "BUFFERING",
      relation,
      questionType,
      intent: intentFor(rewrite.normalizedText),
      subQuestions: slots,
      requirements,
      entities: entityResult.entities,
      references,
      contextSnapshot,
      ...(projectId ? { projectId } : {}),
      confidence: { speechAct: speech.confidence, completion: completion.confidence, reference: Math.min(referenceConfidence, contextResolution.confidence), project: resolvedProject.confidence || 0, asr: asrConfidence, overall: Math.min(overall, contextResolution.confidence) },
      commitStatus: input.final ? completion.state === "COMPLETE" ? "READY" : "WAITING" : "BUFFERING",
      unresolvedSlots: [...completion.unresolvedSlots],
      ...(rewrite.corrections[0] ? { asrRepair: { ...rewrite.corrections[0] } } : {}),
      reason: `${speech.reason}+${completion.reason}`,
      createdAt: now,
      updatedAt: now
    };
    if (isTopicOnlyFragment(rewrite.normalizedText)) {
      frame.completion = "OPEN";
      frame.speechAct = "QUESTION";
      frame.unresolvedSlots = ["predicate"];
      frame.reason = "topic-fragment-awaiting-predicate";
    }
    return { frame, rewrite };
  }
}
