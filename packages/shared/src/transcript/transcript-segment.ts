import type { TranscriptSegment, TranscriptSource } from "@interview-copilot/protocol";

/** Runtime speaker names are deliberately independent from ASR provider names. */
export type TranscriptSpeaker = "interviewer" | "candidate";

export function speakerForSource(source: TranscriptSource): TranscriptSpeaker {
  return source === "mic" ? "candidate" : "interviewer";
}

export function sourceForSpeaker(speaker: TranscriptSpeaker): TranscriptSource {
  return speaker === "candidate" ? "mic" : "remote";
}

export interface TranscriptFragment {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  rawText?: string;
  startTs: number;
  endTs: number;
  final: boolean;
  endpoint?: boolean;
  speechFinal?: boolean;
  utteranceEnd?: boolean;
  endOfTurn?: boolean;
  utteranceId?: string;
  confidence?: number;
}

export function fragmentFromSegment(segment: TranscriptSegment, rawText = segment.text): TranscriptFragment {
  return {
    id: segment.id,
    speaker: speakerForSource(segment.source),
    text: segment.text,
    rawText,
    startTs: segment.startMs,
    endTs: segment.endMs,
    final: segment.final,
    ...(segment.endpoint === undefined ? {} : { endpoint: segment.endpoint }),
    ...(segment.speechFinal === undefined ? {} : { speechFinal: segment.speechFinal }),
    ...(segment.utteranceEnd === undefined ? {} : { utteranceEnd: segment.utteranceEnd }),
    ...(segment.endOfTurn === undefined ? {} : { endOfTurn: segment.endOfTurn }),
    ...(segment.utteranceId ? { utteranceId: segment.utteranceId } : {}),
    ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {})
  };
}

export interface TranscriptUtterance {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  rawText: string;
  startTs: number;
  endTs: number;
  fragments: string[];
  segmentIds: string[];
  finalized: boolean;
  confidence?: number;
}
