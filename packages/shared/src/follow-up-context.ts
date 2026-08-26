import type { InterviewMemorySnapshot, InterviewMemoryTurn } from "./interview-memory";

export interface FollowUpContext {
  rootQuestion: string;
  parentQuestion: string;
  parentAnswer?: string;
  currentQuestion: string;
  currentTopic?: string;
  relatedProject?: string;
  relatedTechnicalTopic?: string;
}

export interface FollowUpQuestionRef {
  id?: string;
  parentQuestionId?: string;
  rootQuestionId?: string;
  text: string;
}

function findTurn(turns: InterviewMemoryTurn[], id?: string): InterviewMemoryTurn | undefined {
  return id ? turns.find((turn) => turn.questionId === id) : undefined;
}

/** Selects the smallest useful thread context for an elliptical follow-up. */
export class FollowUpContextResolver {
  resolve(question: FollowUpQuestionRef, memory: InterviewMemorySnapshot, options: { relatedProject?: string; relatedTechnicalTopic?: string } = {}): FollowUpContext {
    const turns = memory.turns;
    const current = findTurn(turns, question.id);
    const parent = findTurn(turns, question.parentQuestionId)
      ?? (current?.parentQuestionId ? findTurn(turns, current.parentQuestionId) : undefined)
      // Only fall back to temporal adjacency when no explicit thread id was
      // supplied. A missing/stale id must never silently bind the question to
      // an unrelated latest topic.
      ?? (!question.parentQuestionId ? turns.at(-2) ?? turns.at(-1) : undefined);
    const root = findTurn(turns, question.rootQuestionId)
      ?? (parent?.rootQuestionId ? findTurn(turns, parent.rootQuestionId) : undefined)
      ?? parent
      ?? turns[0];
    return {
      rootQuestion: root?.question ?? parent?.question ?? question.text,
      parentQuestion: parent?.question ?? question.text,
      ...(parent?.answer ? { parentAnswer: parent.answer } : {}),
      currentQuestion: question.text,
      ...(memory.currentTopic ? { currentTopic: memory.currentTopic } : {}),
      ...(options.relatedProject ? { relatedProject: options.relatedProject } : {}),
      ...(options.relatedTechnicalTopic ? { relatedTechnicalTopic: options.relatedTechnicalTopic } : {})
    };
  }
}
