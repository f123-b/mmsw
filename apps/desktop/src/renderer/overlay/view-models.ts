import type { AnswerThread } from "@interview-copilot/shared";

export interface QuestionOverlayGroup {
  id: string;
  primaryQuestion?: string;
  displayable?: boolean;
  status?: "collecting" | "answering" | "active" | "closed";
  items: Array<{ text: string; type: string; answerable: boolean }>;
}

export interface QuestionOverlayViewModel {
  currentQuestion?: string;
  currentFollowUp?: string;
  activeGroupId?: string;
  hasHistory: boolean;
  historyCount: number;
  status?: "listening" | "detected";
}

export interface AnswerOverlayViewModel {
  question?: string;
  answer: string;
  streaming: boolean;
  hasOlderAnswers: boolean;
  olderAnswerCount: number;
}

function displayable(group: QuestionOverlayGroup): boolean {
  return group.displayable !== false && Boolean(group.primaryQuestion);
}

export function buildQuestionOverlayViewModel(groups: QuestionOverlayGroup[], activeGroupId?: string, fallbackQuestion?: string): QuestionOverlayViewModel {
  const visible = groups.filter(displayable);
  const activeCandidates = visible.filter((group) => group.status !== "closed");
  const active = activeCandidates.find((group) => group.id === activeGroupId) ?? activeCandidates.at(-1);
  const olderCount = Math.max(0, visible.length - (active ? 1 : 0));
  const currentFollowUp = active?.items.find((item) => item.answerable && item.type === "FOLLOW_UP")?.text;
  return {
    ...(active?.primaryQuestion ?? fallbackQuestion ? { currentQuestion: active?.primaryQuestion ?? fallbackQuestion } : {}),
    ...(currentFollowUp ? { currentFollowUp } : {}),
    ...(active ? { activeGroupId: active.id } : {}),
    hasHistory: olderCount > 0,
    historyCount: olderCount,
    status: active ? "detected" : "listening"
  };
}

export function buildAnswerOverlayViewModel(threads: AnswerThread[], activeGroupId?: string, fallbackQuestion?: string, fallbackAnswer = "", streaming = false): AnswerOverlayViewModel {
  const active = threads.find((thread) => thread.groupId === activeGroupId) ?? threads.at(-1);
  const latest = active?.answers.at(-1);
  const answer = latest?.answerText || fallbackAnswer;
  const question = latest?.questionText || active?.title || fallbackQuestion;
  return {
    ...(question ? { question } : {}),
    answer,
    streaming: streaming || latest?.status === "generating",
    hasOlderAnswers: Boolean(active && threads.some((thread) => thread.groupId !== active.groupId)),
    olderAnswerCount: active ? threads.filter((thread) => thread.groupId !== active.groupId).reduce((count, thread) => count + thread.answers.length, 0) : 0
  };
}
