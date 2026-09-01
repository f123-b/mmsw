import type { TerminologyResolution } from "../terminology";

export type AsrUnderstandingQuality = "resolved" | "repairable" | "unresolved";
export type AsrSemanticDecision = "ACCEPT" | "RESOLVE" | "WAIT" | "UNRESOLVED";

/**
 * The final ASR trust decision consumed by the question runtime.  This is
 * deliberately a semantic contract rather than a detector score: an answer
 * may only be committed after the transcript has passed this gate.
 */
export interface AsrSemanticAssessment {
  normalizedText: string;
  confidence: number;
  unresolvedTerms: string[];
  suspiciousTerms: string[];
  contextConsistent: boolean;
  decision: AsrSemanticDecision;
}

export interface AsrSemanticContext {
  acousticConfidence?: number;
  terminologyConfidence?: number;
  currentTopic?: string;
  recentInterviewerTurns?: string[];
  knownTerms?: string[];
  syntaxComplete?: boolean;
  contextConsistent?: boolean;
  topicConsistent?: boolean;
  plausible?: boolean;
}

export interface UnresolvedAsrDecision {
  quality: AsrUnderstandingQuality;
  confidence: number;
  shouldAnswer: boolean;
  reason: string;
  assessment?: AsrSemanticAssessment;
}

const GARBLED_ASR = /(?:非二G|二G的时里|时里|针头|电炉环|Woodloader)/iu;
const ACRONYM = /\b[A-Z]{2,10}\b/gu;
const SPACED_ACRONYM = /\b(?:[A-Z]\s+){1,}[A-Z]\b/gu;
const COMMON_WORDS = new Set(["AS", "IS", "OR", "AND", "THE", "CAN", "CPU", "GPU", "API", "SDK", "USB", "RTOS", "SPI", "IIC", "I2C"]);
const BUILTIN_TECHNICAL_TERMS = new Set(["SPI", "IIC", "I2C", "UART", "CAN", "FOC", "DMA", "ADC", "DAC", "PWM", "GPIO", "CPU", "GPU", "API", "SDK", "USB", "RTOS", "MQTT", "TCP", "UDP", "HTTP", "MCU", "ARM", "FPGA", "BSP", "HAL", "ISR", "IRQ", "NMI", "NVIC", "SVC", "PSP", "MSP", "CSP", "EEPROM", "STM32", "DSP", "MMU", "MPU", "TLB"]);

function compactAcronym(value: string): string { return value.replace(/\s+/g, "").toUpperCase(); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function extractTechnicalTokens(text: string): string[] {
  return unique([
    ...(text.match(ACRONYM) ?? []),
    ...(text.match(SPACED_ACRONYM) ?? []).map(compactAcronym)
  ]);
}

function knownTokenSet(context: AsrSemanticContext, resolution?: Pick<TerminologyResolution, "possibleTerms" | "corrections">): Set<string> {
  return new Set([
    ...BUILTIN_TECHNICAL_TERMS,
    ...(context.knownTerms ?? []),
    ...(context.currentTopic ? [context.currentTopic] : []),
    ...(context.recentInterviewerTurns ?? []).flatMap(extractTechnicalTokens),
    ...(resolution?.possibleTerms?.map((item) => item.value) ?? []),
    ...(resolution?.corrections?.flatMap((item) => [item.raw, item.canonical]) ?? [])
  ].map(compactAcronym));
}

function assessSemantic(text: string, resolution?: Pick<TerminologyResolution, "confidence" | "possibleTerms" | "corrections">, context: AsrSemanticContext = {}): AsrSemanticAssessment {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const known = knownTokenSet(context, resolution);
  const suspiciousTerms = extractTechnicalTokens(normalizedText)
    .filter((term) => !COMMON_WORDS.has(term) && !known.has(compactAcronym(term)));
  const unresolvedTerms = unique([
    ...(GARBLED_ASR.test(normalizedText) ? normalizedText.match(GARBLED_ASR)?.slice(0, 1) ?? [] : []),
    ...suspiciousTerms
  ]);
  const terminologyConfidence = resolution?.confidence ?? context.terminologyConfidence ?? 1;
  const acousticConfidence = context.acousticConfidence ?? 0.92;
  const syntax = context.syntaxComplete ?? true;
  const contextConsistent = context.contextConsistent ?? context.topicConsistent ?? true;
  const plausibility = context.plausible ?? true;
  const score = Math.max(0, Math.min(1, Number((
    acousticConfidence * 0.26
    + terminologyConfidence * 0.24
    + (syntax ? 0.2 : 0.08)
    + (contextConsistent ? 0.18 : 0.06)
    + (plausibility ? 0.12 : 0.04)
  ).toFixed(3))));
  let decision: AsrSemanticDecision = "ACCEPT";
  if (!normalizedText || unresolvedTerms.length > 0 || GARBLED_ASR.test(normalizedText)) decision = "UNRESOLVED";
  else if (!syntax || score < 0.45) decision = "WAIT";
  else if ((resolution?.possibleTerms?.length ?? 0) > 0 || score < 0.85) decision = "RESOLVE";
  const trustConfidence = GARBLED_ASR.test(normalizedText)
    ? Math.min(score, 0.18)
    : unresolvedTerms.length > 0 ? Math.min(score, 0.32) : score;
  return { normalizedText, confidence: trustConfidence, unresolvedTerms, suspiciousTerms, contextConsistent, decision };
}

/** Keeps low-quality ASR from becoming a high-confidence answer request. */
export class UnresolvedAsrGate {
  assess(text: string, resolution?: Pick<TerminologyResolution, "confidence" | "possibleTerms" | "corrections">, context: AsrSemanticContext = {}): UnresolvedAsrDecision {
    const assessment = assessSemantic(text, resolution, context);
    const quality: AsrUnderstandingQuality = assessment.decision === "ACCEPT" ? "resolved" : assessment.decision === "UNRESOLVED" ? "unresolved" : "repairable";
    const reason = assessment.decision === "UNRESOLVED"
      ? assessment.unresolvedTerms.length ? "unresolved-technical-term" : "garbled-asr-without-repair"
      : assessment.decision === "WAIT" ? "semantic-asr-wait"
        : assessment.decision === "RESOLVE" ? "ambiguous-terminology" : "resolved";
    return { quality, confidence: assessment.confidence, shouldAnswer: assessment.decision === "ACCEPT", reason, assessment };
  }

  assessSemantic(text: string, resolution?: Pick<TerminologyResolution, "confidence" | "possibleTerms" | "corrections">, context: AsrSemanticContext = {}): AsrSemanticAssessment {
    return assessSemantic(text, resolution, context);
  }
}
