import type { AnswerThread, TranscriptSnapshot } from "@interview-copilot/shared";

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

export interface DialogueSpeakingBlock {
  id: string;
  speaker: "interviewer" | "candidate";
  label: "面试官" | "我";
  text: string;
  startMs: number;
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
  const totalAnswers = threads.reduce((count, thread) => count + thread.answers.length, 0);
  const olderAnswerCount = Math.max(0, totalAnswers - (latest ? 1 : 0));
  return {
    ...(question ? { question } : {}),
    answer,
    streaming: streaming || latest?.status === "generating",
    hasOlderAnswers: olderAnswerCount > 0,
    olderAnswerCount
  };
}

/** UI-only dialogue projection. It deliberately keeps no transcript history outside the latest blocks. */
export function buildDialogueOverlayViewModel(remote: TranscriptSnapshot | undefined, mic: TranscriptSnapshot | undefined, maxBlocks = 8): DialogueSpeakingBlock[] {
  const blocks = [
    ...(remote?.final ?? []).map((segment) => ({ id: `remote-${segment.id}`, speaker: "interviewer" as const, label: "面试官" as const, text: segment.text.trim(), startMs: segment.startMs })),
    ...(mic?.final ?? []).map((segment) => ({ id: `mic-${segment.id}`, speaker: "candidate" as const, label: "我" as const, text: segment.text.trim(), startMs: segment.startMs })),
    ...(remote?.partial?.text?.trim() ? [{ id: `remote-partial-${remote.partial.id}`, speaker: "interviewer" as const, label: "面试官" as const, text: remote.partial.text.trim(), startMs: remote.partial.startMs }] : []),
    ...(mic?.partial?.text?.trim() ? [{ id: `mic-partial-${mic.partial.id}`, speaker: "candidate" as const, label: "我" as const, text: mic.partial.text.trim(), startMs: mic.partial.startMs }] : [])
  ].filter((block) => block.text.length > 0).sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  return blocks.slice(-Math.max(4, Math.min(8, maxBlocks)));
}
