import { normalizeTechnicalTerms } from "../terminology";
import type { ActiveProjectContext, ContextResolution, EntityAnchor, QuestionContextReference } from "./question-frame";

export interface ContextualQuestionResolutionInput {
  rawText: string;
  activeProject?: ActiveProjectContext;
  currentTopic?: string;
  activeEntities?: readonly EntityAnchor[];
  previousQuestion?: string;
  previousAnswer?: string;
  normalizedText?: string;
}

const REFERENCE = /它|这个|那个|这个项目|该项目|这个芯片|这个模式|这种方式|这样|这么做|刚才那个|前面那个|多久|哪个|哪一个/giu;

function clean(value: string): string { return normalizeTechnicalTerms(value).replace(/\s+/g, " ").trim(); }
function compact(value: string): string { return clean(value).replace(/[，。！？?！、；;：:\s]/gu, ""); }
function trimQuestion(value: string): string { return clean(value).replace(/[。！!；;]+$/gu, ""); }
function short(value: string, limit = 80): string { return trimQuestion(value).slice(0, limit); }

function contextValues(input: ContextualQuestionResolutionInput): string[] {
  return [input.currentTopic, input.activeProject?.name, ...(input.activeProject?.entities ?? []), ...(input.activeEntities ?? []).map((item) => item.value), input.previousQuestion, input.previousAnswer].filter((value): value is string => Boolean(value));
}

function referenceType(raw: string): string {
  if (/项目/u.test(raw)) return "project";
  if (/芯片/u.test(raw)) return "component";
  if (/模式|方式/u.test(raw)) return "technology";
  if (/多久|哪个|哪一个/u.test(raw)) return "object";
  if (/问题|这么做|这样|刚才|前面/u.test(raw)) return "question";
  return "entity";
}

function resolveReference(raw: string, input: ContextualQuestionResolutionInput, values: string[]): QuestionContextReference | undefined {
  const project = input.activeProject?.name;
  const technology = values.find((value) => /DMA|ADC|PWM|FOC|中断|异常|栈|SPI|CAN|RTOS/iu.test(value));
  const component = values.find((value) => /STM32|F\d{3,4}|MCU|芯片|控制器/iu.test(value));
  const resolved = /项目/u.test(raw) ? project : /芯片/u.test(raw) ? component : /模式|方式/u.test(raw) ? technology : /多久/u.test(raw) ? technology ?? input.currentTopic : /这么做|这样|刚才|前面/u.test(raw) ? input.previousQuestion : component ?? technology ?? input.previousQuestion;
  if (!resolved) return undefined;
  return { raw, resolved, type: referenceType(raw), confidence: /多久/u.test(raw) && !technology ? 0.62 : 0.93 };
}

function canonicalize(text: string, input: ContextualQuestionResolutionInput, references: QuestionContextReference[], values: string[]): string {
  let value = trimQuestion(text);
  // An inherited F405 entity can disambiguate a later reference, but it must
  // not manufacture the selected object before the interviewer has spoken it.
  const hasF405 = /STM32F405|F405/iu.test(value);
  const hasProject = Boolean(input.activeProject?.name);
  if (/(?:interrupt|exception|stack|nesting|hardware\s+stacking|中断|异常|嵌套|硬件压栈)[\s\S]{0,120}(?:哪个栈|哪个站)/iu.test(value)) return "哪个栈？";
  if (/(?:为什么(?:要)?选|为什么(?:要)?选择)/iu.test(value) && hasF405) {
    const projectName = (input.activeProject?.name ?? (values.find((item) => /FOC|电机|矢量/iu.test(item)) ? "FOC / 电机控制" : "当前")).replace(/\s*项目$/u, "");
    return `为什么在 ${projectName}项目中选择 STM32F405？选型时主要考虑了哪些因素？`;
  }
  if (/多久(?:触发|搬运|传输)?(?:一次)?/iu.test(value)) {
    const hasAdc = values.some((item) => /ADC|采样/iu.test(item));
    const hasDma = values.some((item) => /DMA/iu.test(item));
    if (hasAdc) return "这个项目的 ADC/DMA 数据采集链路多久触发一次？";
    if (hasDma) return "项目里的 DMA 传输/触发周期是多少？";
  }
  if (/为什么(?:这么做|这样做|要这样|这样设计)/iu.test(value) && input.previousQuestion) {
    return `为什么要这样设计（${short(input.previousQuestion)}）？`;
  }
  if (/F[四4]\s*是.*(?:河|核)|F4.*(?:河|核)/iu.test(value) && values.some((item) => /STM32|Cortex|MCU|F4/iu.test(item))) {
    return "STM32F4 是什么 Cortex 内核？";
  }
  if (references.length && /(?:它|这个|那个|哪个|哪一个|多久|这么做|这样)/u.test(value)) {
    const target = references.find((item) => item.confidence >= 0.8)?.resolved;
    const targetAlreadyPresent = target && (compact(value).includes(compact(target)) || /stack/iu.test(target) && /栈/iu.test(value) || /栈/iu.test(target) && /stack/iu.test(value));
    if (target && /^(?:多久|哪个|哪一个)/u.test(value) && !targetAlreadyPresent) value = `${target}${value}`;
  }
  if (hasProject && /(?:项目|系统|平台)/u.test(value) === false && input.currentTopic && /(?:怎么|如何|什么|为什么|哪个|多久)/u.test(value) && /^(?:它|这个|那个|哪个|哪一个|多久|为什么)/u.test(value)) value = `${input.currentTopic}：${value}`;
  return value + (/[？?]$/u.test(value) ? "" : /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪个|多久|吗|呢|区别|原理|作用|原因|选择|选)/iu.test(value) ? "？" : "");
}

/** Resolves short references into the explicit question consumed downstream. */
export function resolveContextualQuestion(input: ContextualQuestionResolutionInput): ContextResolution {
  const rawText = clean(input.rawText);
  const normalized = clean(input.normalizedText ?? rawText);
  const values = contextValues(input);
  const references: QuestionContextReference[] = [];
  for (const raw of normalized.match(REFERENCE) ?? []) {
    const resolved = resolveReference(raw, input, values);
    if (resolved && !references.some((item) => item.raw === raw && item.resolved === resolved.resolved)) references.push(resolved);
  }
  const unresolved = references.length === 0 && /^(?:它|这个|那个|哪个|哪一个|多久|为什么这么做|为什么这样做)[？?。！!]?$/u.test(normalized) && !values.length ? [normalized] : references.filter((item) => item.confidence < 0.8).map((item) => item.raw);
  const canonicalQuestion = canonicalize(normalized, input, references, values);
  const inherited = {
    ...(input.activeProject ? { project: input.activeProject.name } : {}),
    ...(input.currentTopic ? { topic: input.currentTopic } : {}),
    ...(values.find((value) => /STM32|F\d{3,4}|MCU|芯片|控制器/iu.test(value)) ? { component: values.find((value) => /STM32|F\d{3,4}|MCU|芯片|控制器/iu.test(value)) } : {}),
    ...(values.find((value) => /DMA|ADC|PWM|FOC|中断|异常|栈|SPI|CAN|RTOS/iu.test(value)) ? { technology: values.find((value) => /DMA|ADC|PWM|FOC|中断|异常|栈|SPI|CAN|RTOS/iu.test(value)) } : {})
  };
  const confidence = unresolved.length ? 0.45 : Math.min(0.98, references.length ? Math.min(...references.map((item) => item.confidence)) : 0.94);
  return { rawText, references, inherited, canonicalQuestion, confidence, unresolved };
}

export function contextResolutionReferences(resolution: ContextResolution): QuestionContextReference[] {
  return resolution.references.map((item) => ({ ...item }));
}
