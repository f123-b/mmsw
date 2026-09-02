import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { QuestionEvent, SessionState } from "@interview-copilot/shared";

export type SessionPhase = "IDLE" | "STARTING" | "LISTENING" | "DEGRADED" | "STOPPING" | "ERROR";
export type QuestionPhase = "EMPTY" | "ASSEMBLING" | "DETECTED" | "COMMITTED";
export type AnswerPhase = "EMPTY" | "QUEUED" | "GENERATING" | "READY" | "ERROR";
export type AutomationMode = "AUTO" | "MANUAL";

export interface RuntimePhaseState {
  sessionPhase: SessionPhase;
  questionPhase: QuestionPhase;
  answerPhase: AnswerPhase;
  automationMode: AutomationMode;
  activeQuestionGroupId?: string;
  activeAnswerGroupId?: string;
}

export const initialRuntimePhaseState: RuntimePhaseState = {
  sessionPhase: "IDLE",
  questionPhase: "EMPTY",
  answerPhase: "EMPTY",
  automationMode: "AUTO"
};

export function sessionPhaseFor(sessionState: SessionState | string, audioState = "STOPPED", realtimeState = "disconnected"): SessionPhase {
  if (sessionState === "ERROR" || audioState === "FAILED" || realtimeState === "error") return "ERROR";
  if (sessionState === "ENDING") return "STOPPING";
  if (sessionState === "IDLE" || sessionState === "ENDED") return "IDLE";
  if (sessionState === "CREATING" || sessionState === "CONNECTING") return "STARTING";
  if (audioState === "STARTING") return "STARTING";
  if (sessionState === "RECONNECTING" || audioState === "DEGRADED" || audioState === "RECOVERING" || realtimeState === "reconnecting") return "DEGRADED";
  if (sessionState === "RUNNING" && (audioState === "STOPPED" || realtimeState === "disconnected")) return "DEGRADED";
  return "LISTENING";
}

export function isDisplayableQuestionGroup(group: { displayable?: boolean; hasAnswerableQuestion?: boolean; items?: Array<{ answerable: boolean }> } | undefined): boolean {
  return Boolean(group && group.displayable !== false && group.hasAnswerableQuestion !== false && group.items?.some((item) => item.answerable));
}

export function isCommittedQuestionGroup(group: { status?: string; displayable?: boolean; hasAnswerableQuestion?: boolean; items?: Array<{ answerable: boolean }> } | undefined): boolean {
  return isDisplayableQuestionGroup(group) && group?.status !== "closed";
}

export function sessionStatusLabel(phase: SessionPhase): string {
  if (phase === "STARTING") return "正在启动";
  if (phase === "DEGRADED") return "连接降级";
  if (phase === "STOPPING") return "正在结束";
  if (phase === "ERROR") return "运行错误";
  if (phase === "IDLE") return "未开始";
  return "正在听取";
}

export function answerStatusLabel(phase: AnswerPhase): string | undefined {
  if (phase === "QUEUED") return "等待生成";
  if (phase === "GENERATING") return "正在生成回答";
  if (phase === "READY") return "回答已就绪";
  if (phase === "ERROR") return "回答失败";
  return undefined;
}

export function primaryRuntimeStatus(state: RuntimePhaseState): string {
  // Session lifecycle owns the primary status. Only an in-flight answer
  // temporarily replaces LISTENING; READY is a secondary indicator and must
  // never make a still-listening session look finished.
  if (state.sessionPhase === "LISTENING" && (state.answerPhase === "QUEUED" || state.answerPhase === "GENERATING")) {
    return answerStatusLabel(state.answerPhase) ?? sessionStatusLabel(state.sessionPhase);
  }
  return sessionStatusLabel(state.sessionPhase);
}

export function reduceRuntimeMessage(state: RuntimePhaseState, message: RealtimeServerMessage, groupId?: string): RuntimePhaseState {
  if (message.type === "answer_start") return { ...state, answerPhase: "GENERATING", ...(groupId ? { activeQuestionGroupId: groupId, activeAnswerGroupId: groupId } : {}) };
  if (message.type === "answer_delta") return { ...state, answerPhase: "GENERATING" };
  if (message.type === "answer_end") return { ...state, answerPhase: "READY" };
  if (message.type === "answer_cancelled" || message.type === "answer_reset") return { ...state, answerPhase: "EMPTY" };
  if (message.type === "runtime_error") return { ...state, answerPhase: "ERROR" };
  return state;
}

export function reduceRuntimeQuestion(state: RuntimePhaseState, event: QuestionEvent): RuntimePhaseState {
  if (event.type === "question_candidate") return { ...state, questionPhase: "ASSEMBLING" };
  if (event.type === "question_diagnostic") return { ...state, questionPhase: questionWaitingNotice(event) ? "ASSEMBLING" : event.confirmed ? "DETECTED" : state.questionPhase };
  if (event.type === "question_confirmed" || event.type === "question_superseded") {
    return event.question.answerable === false ? { ...state, questionPhase: "DETECTED" } : { ...state, questionPhase: "COMMITTED" };
  }
  return state;
}

export function questionWaitingNotice(event: QuestionEvent): string | undefined {
  if (event.type !== "question_diagnostic") return undefined;
  if (event.reason === "understanding-wait-asr") return `识别内容不确定，等待补充：${event.text}`;
  if (event.reason === "understanding-wait-completion") return `正在等待问题说完整：${event.text}`;
  return undefined;
}

export function reduceRuntimeTranscript(state: RuntimePhaseState, source: "mic" | "remote", final: boolean): RuntimePhaseState {
  if (source !== "remote") return state;
  return { ...state, sessionPhase: "LISTENING", ...(final ? { questionPhase: "ASSEMBLING", answerPhase: "EMPTY" as const } : {}) };
}
