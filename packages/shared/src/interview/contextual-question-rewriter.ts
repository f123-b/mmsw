import { normalizeTechnicalTerms } from "../terminology";
import type { ActiveProjectContext, AsrAmbiguity, EntityAnchor } from "./question-frame";

export interface ContextualQuestionRewriteInput {
  rawText: string;
  currentTopic?: string;
  previousQuestion?: string;
  activeProject?: ActiveProjectContext;
  activeEntities?: EntityAnchor[];
}

export interface ContextualQuestionRewriteResult {
  normalizedText: string;
  corrections: Array<{ raw: string; canonical: string; confidence: number; reason: string }>;
  candidates: Array<{ raw: string; candidate: string; confidence: number; reason: string }>;
  unresolved: AsrAmbiguity[];
}

const F405 = /F\s*(?:四零五|405)|四零五/iu;
const STACK = /(?:stack|exception|interrupt|nesting|hardware\s+stacking|栈|中断|异常|嵌套)/iu;
const DMA = /\bDMA\b|直接存储器访问/iu;
const CORTEX = /(?:STM32|Cortex-[MAR]|MCU|F4|内核|NVIC)/iu;

function contextText(input: ContextualQuestionRewriteInput): string {
  return [input.rawText, input.currentTopic, input.previousQuestion, input.activeProject?.name, ...(input.activeProject?.entities ?? []), ...(input.activeEntities ?? []).map((item) => item.value)].filter(Boolean).join(" ");
}

/** Repairs ASR only when phonetic evidence and technical context agree. */
export class ContextualQuestionRewriter {
  rewrite(input: ContextualQuestionRewriteInput): ContextualQuestionRewriteResult {
    const rawText = input.rawText.replace(/\s+/g, " ").trim();
    let normalizedText = normalizeTechnicalTerms(rawText).replace(/\s+/g, " ").trim();
    const corrections: ContextualQuestionRewriteResult["corrections"] = [];
    const candidates: ContextualQuestionRewriteResult["candidates"] = [];
    const unresolved: AsrAmbiguity[] = [];
    const context = contextText(input);

    if (F405.test(normalizedText) && /(?:FOC|电机|矢量|控制器|MCU|选|平台)/iu.test(context)) {
      normalizedText = normalizedText.replace(F405, "STM32F405");
      corrections.push({ raw: "F四零五", canonical: "STM32F405", confidence: 0.99, reason: "motor-control-component-context" });
    }

    if (/电鳗/iu.test(normalizedText)) {
      if (DMA.test(context) && /(?:怎么工作|如何工作|怎么用|什么模式|原理)/iu.test(normalizedText)) {
        normalizedText = normalizedText.replace(/电鳗/giu, "DMA");
        corrections.push({ raw: "电鳗", canonical: "DMA", confidence: 0.91, reason: "dma-topic-phonetic-context" });
      } else {
        unresolved.push({ raw: "电鳗", candidates: ["DMA"], confidence: 0.28, reason: "phonetic-candidate-without-sufficient-technical-context" });
      }
    }

    if (/哪个站/iu.test(normalizedText)) {
      if (STACK.test(context)) {
        normalizedText = normalizedText.replace(/哪个站/giu, "哪个栈");
        corrections.push({ raw: "哪个站", canonical: "哪个栈", confidence: 0.9, reason: "stack-and-exception-context" });
      } else {
        unresolved.push({ raw: "哪个站", candidates: ["哪个栈"], confidence: 0.3, reason: "ambiguous-homophone-without-context" });
      }
    }

    if (/F[四4]\s*是.*(?:河|核)|F4.*(?:河|核)/iu.test(normalizedText)) {
      if (CORTEX.test(context)) {
        normalizedText = normalizedText.replace(/F[四4]\s*是.*?(?:河|核)(?:吗)?/iu, "STM32F4 是什么 Cortex 内核");
        corrections.push({ raw: "F四是哪个河吗", canonical: "STM32F4 是什么 Cortex 内核", confidence: 0.94, reason: "stm32-core-context" });
      } else {
        candidates.push({ raw: "F四是哪个河吗", candidate: "STM32F4 是什么 Cortex 内核", confidence: 0.62, reason: "cortex-core-candidate-needs-context" });
        unresolved.push({ raw: "F四是哪个河吗", candidates: ["STM32F4 是什么 Cortex 内核"], confidence: 0.62, reason: "cortex-core-reference-without-context" });
      }
    }

    if (/(?:非)?向量终端/iu.test(normalizedText)) {
      if (CORTEX.test(context) || /中断|异常|向量/iu.test(context)) {
        normalizedText = normalizedText.replace(/向量终端/giu, "向量中断").replace(/非向量中断/giu, "非向量中断");
        corrections.push({ raw: "向量终端", canonical: "向量中断", confidence: 0.96, reason: "interrupt-terminology-context" });
      } else {
        candidates.push({ raw: "向量终端", candidate: "向量中断", confidence: 0.64, reason: "interrupt-terminology-needs-context" });
        unresolved.push({ raw: "向量终端", candidates: ["向量中断"], confidence: 0.64, reason: "interrupt-term-without-context" });
      }
    }

    if (/核心future/iu.test(normalizedText)) {
      candidates.push({ raw: "核心future", candidate: "核心特性", confidence: 0.58, reason: "low-confidence-asr-candidate" });
      unresolved.push({ raw: "核心future", candidates: ["核心特性"], confidence: 0.58, reason: "low-confidence-technical-asr" });
    }

    return { normalizedText, corrections, candidates, unresolved };
  }
}

/** Explicit name for the shared high/medium/low confidence ASR repair lane. */
export class ContextualAsrCandidateResolver extends ContextualQuestionRewriter {}
