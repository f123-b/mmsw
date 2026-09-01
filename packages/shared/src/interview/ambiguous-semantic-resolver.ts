import type { FragmentDependency, SemanticTurnSpeechAct } from "./semantic-turn-gate";

export interface AmbiguousSemanticInput {
  previousInterviewerTurns: string[];
  pendingFragments: string[];
  previousCandidateAnswer: string;
  activeTopic: string;
  activeProject: string;
  activeEntity: string;
}

export interface AmbiguousSemanticResult {
  speechAct: SemanticTurnSpeechAct;
  complete: boolean;
  canonicalQuestion: string;
  relation: "NEW_TOPIC" | "FOLLOW_UP";
  shouldAnswer: boolean;
  confidence: number;
}

export type AmbiguousSemanticClient = (input: AmbiguousSemanticInput, options: { temperature: 0; maxTokens: number }) => Promise<unknown>;

function isResult(value: unknown): value is AmbiguousSemanticResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["QUESTION", "ANSWER_REQUEST", "FOLLOW_UP_REQUEST", "STATEMENT", "BACKCHANNEL", "INCOMPLETE", "ASR_NOISE"].includes(String(item.speechAct))
    && typeof item.complete === "boolean"
    && typeof item.canonicalQuestion === "string"
    && ["NEW_TOPIC", "FOLLOW_UP"].includes(String(item.relation))
    && typeof item.shouldAnswer === "boolean"
    && typeof item.confidence === "number";
}

function parse(value: unknown): AmbiguousSemanticResult | undefined {
  if (typeof value === "string") {
    try { return parse(JSON.parse(value)); } catch { return undefined; }
  }
  if (!isResult(value)) return undefined;
  return { ...value, confidence: Math.max(0, Math.min(1, value.confidence)) };
}

/** Calls a tiny semantic resolver only for the explicitly ambiguous band. */
export class AmbiguousSemanticResolver {
  constructor(private readonly client?: AmbiguousSemanticClient) {}

  shouldResolve(confidence: number): boolean { return confidence >= 0.4 && confidence < 0.85; }

  async resolve(input: AmbiguousSemanticInput, confidence: number): Promise<AmbiguousSemanticResult | undefined> {
    if (!this.client || !this.shouldResolve(confidence)) return undefined;
    const result = await this.client(input, { temperature: 0, maxTokens: 96 });
    return parse(result);
  }
}
