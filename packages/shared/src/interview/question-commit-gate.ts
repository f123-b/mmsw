import type { QuestionFrame, QuestionFrameCommitStatus } from "./question-frame";

export type QuestionCommitDecision = "COMMIT" | "WAIT" | "REJECT";

export interface QuestionCommitGateResult {
  decision: QuestionCommitDecision;
  status: QuestionFrameCommitStatus;
  reason: string;
  postCompletionReady: boolean;
}

function isDirectAnswerableQuestion(frame: QuestionFrame): boolean {
  const text = `${frame.canonicalQuestion} ${frame.rawCombinedText}`.trim();
  const compact = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (compact.length < 4) return false;
  if (/(?:为什么.*(?:要)?选|(?:是)?用的什么)[？?。！!，,、\s]*$/u.test(text)) return false;
  return /(?:为何|为什么|怎么|如何|哪(?:个|些|一种)|多少|是否|是不是|能否|可否|区别|优点|缺点|优势|劣势|作用|原理|(?:是|有|做|负责|用|选|包含|包括)什么|什么(?:是|区别|作用|原理|优势|项目|原因|特点|问题))/u.test(text)
    || /(?:介绍|讲述|讲讲|说说).{0,12}(?:项目|经历|自己|优势|技术|系统)|(?:项目|经历).{0,8}(?:介绍|讲述|讲讲|说说)/u.test(text);
}

/** The only final authority for turning an understanding frame into a question. */
export class QuestionCommitGate {
  evaluate(frame: QuestionFrame, mode: "ACCURATE_INTERVIEW" | "FAST_PRACTICE" = "ACCURATE_INTERVIEW"): QuestionCommitGateResult {
    // A final, recognizable question must reach the answer pipeline. ASR and
    // reference confidence remain useful context for the model, but must not
    // strand a real interviewer question in WAIT forever.
    const referenceCompleteRequest = frame.completion === "WAITING_REFERENCE"
      && /(?:介绍|讲述|讲讲|说说).{0,12}(?:这个|该|当前)?项目/u.test(frame.canonicalQuestion);
    if (isDirectAnswerableQuestion(frame) && (frame.completion === "COMPLETE" || referenceCompleteRequest) && ["QUESTION", "FOLLOW_UP", "CLARIFICATION"].includes(frame.speechAct)) {
      return { decision: "COMMIT", status: "COMMITTED", reason: "answer-first-direct-question", postCompletionReady: true };
    }
    if (frame.speechAct === "ASR_UNRESOLVED" || frame.completion === "ASR_UNCERTAIN") return { decision: "WAIT", status: "WAITING", reason: "asr-unresolved-no-guess", postCompletionReady: false };
    if (!["QUESTION", "FOLLOW_UP", "CLARIFICATION"].includes(frame.speechAct)) return { decision: "REJECT", status: "REJECTED", reason: `speech-act-${frame.speechAct.toLowerCase()}`, postCompletionReady: false };
    if (frame.completion !== "COMPLETE") return { decision: "WAIT", status: "WAITING", reason: `completion-${frame.completion.toLowerCase()}`, postCompletionReady: false };
    if (frame.speechAct === "FOLLOW_UP" && frame.confidence.reference < 0.8 && mode === "ACCURATE_INTERVIEW") return { decision: "WAIT", status: "WAITING", reason: "follow-up-reference-not-confident", postCompletionReady: false };
    if (frame.confidence.asr < (mode === "ACCURATE_INTERVIEW" ? 0.8 : 0.55)) return { decision: "WAIT", status: "WAITING", reason: "asr-confidence-below-mode-threshold", postCompletionReady: false };
    if (frame.confidence.overall < (mode === "ACCURATE_INTERVIEW" ? 0.78 : 0.55)) return { decision: "WAIT", status: "WAITING", reason: "overall-confidence-below-mode-threshold", postCompletionReady: false };
    return { decision: "COMMIT", status: "COMMITTED", reason: "semantic-completion-and-evidence-satisfied", postCompletionReady: true };
  }
}
