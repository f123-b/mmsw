import type { TranscriptSegment } from "@interview-copilot/protocol";
import { CanonicalRemoteTurnAssembler, type CanonicalRemoteTurn } from "./canonical-remote-turn-assembler";
import { QuestionUnderstanding, type QuestionUnderstandingResult } from "./question-understanding";
import { SemanticTurnGate, type SemanticTurnDecision } from "./semantic-turn-gate";

export interface RealInterviewReplayInput {
  segment: TranscriptSegment;
  receivedAt?: number;
}

export interface RealInterviewReplayCommit {
  turn: CanonicalRemoteTurn;
  semantic: SemanticTurnDecision;
  understanding: QuestionUnderstandingResult;
  committedAt: number;
  commitLatencyMs: number;
}

export interface RealInterviewReplayResult {
  commits: RealInterviewReplayCommit[];
  turns: CanonicalRemoteTurn[];
  answeredTurns: number;
  rejectedTurns: number;
  commitLatencyMs: number[];
}

/**
 * Deterministic replay harness for real ASR-style final/partial sequences.
 * It exercises the same canonical assembler, semantic gate and understanding
 * layer as the live path, including adaptive waits and explicit flushes.
 */
export class RealInterviewQuestionReplay {
  private readonly gate: SemanticTurnGate;
  private readonly assembler: CanonicalRemoteTurnAssembler;
  private readonly understanding: QuestionUnderstanding;
  private readonly commits: RealInterviewReplayCommit[] = [];
  private readonly turns: CanonicalRemoteTurn[] = [];
  private clock = 0;
  private previousQuestion = "";

  constructor(options: ConstructorParameters<typeof CanonicalRemoteTurnAssembler>[0] = {}) {
    this.gate = options.semanticGate ?? new SemanticTurnGate();
    this.assembler = new CanonicalRemoteTurnAssembler({ ...options, semanticGate: this.gate });
    this.understanding = new QuestionUnderstanding();
  }

  push(input: RealInterviewReplayInput): void {
    const receivedAt = input.receivedAt ?? input.segment.endMs ?? this.clock;
    this.advance(receivedAt);
    this.clock = Math.max(this.clock, receivedAt);
    const update = this.assembler.push(input.segment, receivedAt, { previousInterviewerTurn: this.previousQuestion });
    update.completed.forEach((turn) => this.commit(turn, receivedAt));
  }

  advance(at: number): void {
    this.clock = Math.max(this.clock, at);
    for (const turn of this.assembler.pending) {
      const receivedAt = turn.lastFinalReceivedAt ?? turn.firstSegmentReceivedAt ?? turn.endMs;
      if (this.clock - receivedAt >= turn.commitDelayMs) {
        const committed = this.assembler.flush(turn.speaker, this.clock);
        committed.forEach((item) => this.commit(item, this.clock));
      }
    }
  }

  flush(at = this.clock): RealInterviewReplayResult {
    this.clock = Math.max(this.clock, at);
    this.assembler.flush(undefined, this.clock).forEach((turn) => this.commit(turn, this.clock));
    return this.result();
  }

  result(): RealInterviewReplayResult {
    const commits = this.commits.map((item) => ({ ...item, turn: { ...item.turn, fragments: [...item.turn.fragments], segmentIds: [...item.turn.segmentIds] } }));
    return {
      commits,
      turns: this.turns.map((turn) => ({ ...turn, fragments: [...turn.fragments], segmentIds: [...turn.segmentIds] })),
      answeredTurns: commits.filter((item) => item.semantic.shouldAnswer).length,
      rejectedTurns: commits.filter((item) => !item.semantic.shouldAnswer).length,
      commitLatencyMs: commits.map((item) => item.commitLatencyMs)
    };
  }

  private commit(turn: CanonicalRemoteTurn, committedAt: number): void {
    if (this.turns.some((item) => item.id === turn.id && item.finalizedAt === turn.finalizedAt)) return;
    const semantic = turn.semantic ?? this.gate.decide(turn.text, { previousInterviewerTurn: this.previousQuestion });
    const understanding = this.understanding.understand({ text: turn.text, fragments: turn.fragments, semantic, previousQuestion: this.previousQuestion });
    const start = turn.firstSegmentReceivedAt ?? turn.startMs;
    const commit: RealInterviewReplayCommit = { turn, semantic, understanding, committedAt, commitLatencyMs: Math.max(0, committedAt - start) };
    this.commits.push(commit);
    this.turns.push(turn);
    if (semantic.shouldAnswer) this.previousQuestion = understanding.canonicalQuestion;
  }
}

export function replayRealInterviewQuestionSequence(inputs: RealInterviewReplayInput[], options: ConstructorParameters<typeof CanonicalRemoteTurnAssembler>[0] = {}): RealInterviewReplayResult {
  const replay = new RealInterviewQuestionReplay(options);
  inputs.forEach((input) => replay.push(input));
  return replay.flush(inputs.at(-1)?.receivedAt ?? 0);
}
