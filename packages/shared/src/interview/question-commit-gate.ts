import type { QuestionFrame, QuestionFrameCommitStatus } from "./question-frame";

export type QuestionCommitDecision = "COMMIT" | "WAIT" | "REJECT";

export interface QuestionCommitGateResult {
  decision: QuestionCommitDecision;
  status: QuestionFrameCommitStatus;
  reason: string;
  postCompletionReady: boolean;
}

/** The only final authority for turning an understanding frame into a question. */
export class QuestionCommitGate {
  evaluate(frame: QuestionFrame, mode: "ACCURATE_INTERVIEW" | "FAST_PRACTICE" = "ACCURATE_INTERVIEW"): QuestionCommitGateResult {
    if (frame.speechAct === "ASR_UNRESOLVED" || frame.completion === "ASR_UNCERTAIN") return { decision: "WAIT", status: "WAITING", reason: "asr-unresolved-no-guess", postCompletionReady: false };
    if (!["QUESTION", "FOLLOW_UP", "CLARIFICATION"].includes(frame.speechAct)) return { decision: "REJECT", status: "REJECTED", reason: `speech-act-${frame.speechAct.toLowerCase()}`, postCompletionReady: false };
    if (frame.completion !== "COMPLETE") return { decision: "WAIT", status: "WAITING", reason: `completion-${frame.completion.toLowerCase()}`, postCompletionReady: false };
    if (frame.speechAct === "FOLLOW_UP" && frame.confidence.reference < 0.8 && mode === "ACCURATE_INTERVIEW") return { decision: "WAIT", status: "WAITING", reason: "follow-up-reference-not-confident", postCompletionReady: false };
    if (frame.confidence.asr < (mode === "ACCURATE_INTERVIEW" ? 0.8 : 0.55)) return { decision: "WAIT", status: "WAITING", reason: "asr-confidence-below-mode-threshold", postCompletionReady: false };
    if (frame.confidence.overall < (mode === "ACCURATE_INTERVIEW" ? 0.78 : 0.55)) return { decision: "WAIT", status: "WAITING", reason: "overall-confidence-below-mode-threshold", postCompletionReady: false };
    return { decision: "COMMIT", status: "COMMITTED", reason: "semantic-completion-and-evidence-satisfied", postCompletionReady: true };
  }
}
