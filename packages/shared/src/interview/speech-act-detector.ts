import type { InterviewMemorySnapshot } from "../interview-memory";
import { SpeechActClassifier, type SpeechActContext } from "./speech-act-classifier";
import { decideTurnCompletion } from "./turn-completion-gate";

export type SpeechAct = "QUESTION" | "STATEMENT" | "BACKCHANNEL" | "INCOMPLETE" | "COMMAND" | "ASR_NOISE";

export interface SpeechActDetectorContext extends SpeechActContext {
  memory?: InterviewMemorySnapshot;
}

export interface SpeechActDetection {
  speechAct: SpeechAct;
  shouldTriggerAnswer: boolean;
  confidence: number;
  normalizedText: string;
  reason: string;
  sourceSpeechAct: string;
}

function isNoise(text: string): boolean {
  return /^(?:乱码|听不清|无法识别|日制日制|色一块|嗯啊嗯啊|spm|sps)[^？?]*$/iu.test(text.replace(/\s+/g, "").trim());
}

function isStandaloneBackchannel(text: string): boolean {
  return /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|行|可以|还有|然后|那个|就是)[。！？?！\s，,、]*$/iu.test(text.trim());
}

function isIncompleteFragment(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || /[？?]/u.test(normalized)) return false;
  if (/^(?:如果|假设|若|那对于|对于)/u.test(normalized) && !/(?:怎么|如何|怎样|是否|吗|呢|哪些|什么|能不能|可不可以)/u.test(normalized)) return true;
  return /^(?:我们这个项目|这个项目其实|那对于 SPI|那对于这个)/iu.test(normalized) && /(?:…|\.\.\.|其实|就是|项目|SPI)$/iu.test(normalized);
}

/** Stable public speech-act vocabulary over the richer legacy classifier. */
export class SpeechActDetector {
  private readonly classifier: SpeechActClassifier;

  constructor(classifier = new SpeechActClassifier()) { this.classifier = classifier; }

  detect(text: string, context: SpeechActDetectorContext = {}): SpeechActDetection {
    if (isStandaloneBackchannel(text)) return { speechAct: "BACKCHANNEL", shouldTriggerAnswer: false, confidence: 0.99, normalizedText: text.trim(), reason: "standalone-backchannel", sourceSpeechAct: "ACKNOWLEDGEMENT" };
    const classification = this.classifier.classify(text, context);
    const normalized = classification.normalizedText;
    if (isNoise(normalized)) return { speechAct: "ASR_NOISE", shouldTriggerAnswer: false, confidence: 0.92, normalizedText: normalized, reason: "asr-noise-pattern", sourceSpeechAct: classification.speechAct };
    if (isIncompleteFragment(normalized)) return { speechAct: "INCOMPLETE", shouldTriggerAnswer: false, confidence: 0.9, normalizedText: normalized, reason: "open-utterance-fragment", sourceSpeechAct: classification.speechAct };
    if (["ACKNOWLEDGEMENT"].includes(classification.speechAct)) return { speechAct: "BACKCHANNEL", shouldTriggerAnswer: false, confidence: classification.confidence, normalizedText: normalized, reason: classification.reason, sourceSpeechAct: classification.speechAct };
    if (["CONTROL", "TOPIC_TRANSITION", "INSTRUCTION_MODIFIER"].includes(classification.speechAct)) return { speechAct: "COMMAND", shouldTriggerAnswer: false, confidence: classification.confidence, normalizedText: normalized, reason: classification.reason, sourceSpeechAct: classification.speechAct };
    if (["QUESTION", "ANSWER_REQUEST", "CODE_REQUEST", "FOLLOW_UP"].includes(classification.speechAct)) {
      const completion = decideTurnCompletion(normalized);
      if (completion.state === "incomplete") return { speechAct: "INCOMPLETE", shouldTriggerAnswer: false, confidence: completion.confidence, normalizedText: normalized, reason: completion.reason, sourceSpeechAct: classification.speechAct };
      return { speechAct: "QUESTION", shouldTriggerAnswer: true, confidence: classification.confidence, normalizedText: normalized, reason: classification.reason, sourceSpeechAct: classification.speechAct };
    }
    if (classification.speechAct === "META_CONVERSATION" || classification.speechAct === "TOPIC_ANNOUNCEMENT" || classification.speechAct === "TOPIC_ANCHOR") return { speechAct: "STATEMENT", shouldTriggerAnswer: false, confidence: classification.confidence, normalizedText: normalized, reason: classification.reason, sourceSpeechAct: classification.speechAct };
    return { speechAct: "STATEMENT", shouldTriggerAnswer: false, confidence: classification.confidence, normalizedText: normalized, reason: classification.reason, sourceSpeechAct: classification.speechAct };
  }
}

export function detectSpeechAct(text: string, context: SpeechActDetectorContext = {}): SpeechActDetection {
  return new SpeechActDetector().detect(text, context);
}
