export const SESSION_STATES = [
  "IDLE",
  "CREATING",
  "CONNECTING",
  "READY",
  "RUNNING",
  "RECONNECTING",
  "ENDING",
  "ENDED",
  "ERROR"
] as const;

export type SessionState = typeof SESSION_STATES[number];

const transitions: Record<SessionState, readonly SessionState[]> = {
  IDLE: ["CREATING"],
  CREATING: ["CONNECTING", "ERROR"],
  CONNECTING: ["READY", "RECONNECTING", "ERROR"],
  READY: ["RUNNING", "ENDING", "ERROR"],
  RUNNING: ["RECONNECTING", "ENDING", "ERROR"],
  RECONNECTING: ["CONNECTING", "ENDING", "ERROR"],
  ENDING: ["ENDED", "ERROR"],
  ENDED: ["CREATING", "IDLE"],
  ERROR: ["CREATING", "IDLE", "ENDING"]
};

export class InvalidSessionTransitionError extends Error {
  constructor(public readonly from: SessionState, public readonly to: SessionState) {
    super(`Invalid session transition: ${from} → ${to}`);
    this.name = "InvalidSessionTransitionError";
  }
}

export class SessionStateMachine {
  private currentState: SessionState;
  private readonly listeners = new Set<(state: SessionState) => void>();

  constructor(initialState: SessionState = "IDLE") {
    this.currentState = initialState;
  }

  get state(): SessionState {
    return this.currentState;
  }

  canTransition(to: SessionState): boolean {
    return transitions[this.currentState].includes(to);
  }

  transition(to: SessionState): SessionState {
    if (!this.canTransition(to)) {
      throw new InvalidSessionTransitionError(this.currentState, to);
    }
    this.currentState = to;
    this.listeners.forEach((listener) => listener(to));
    return to;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function normalizeMeter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

import type { TranscriptSegment, TranscriptSource } from "@interview-copilot/protocol";

export interface TranscriptSnapshot {
  source: TranscriptSource;
  final: TranscriptSegment[];
  partial?: TranscriptSegment;
}

export interface TranscriptUpdate {
  segment: TranscriptSegment;
  snapshot: TranscriptSnapshot;
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class TranscriptStabilizer {
  private readonly finals: Record<TranscriptSource, TranscriptSegment[]> = { mic: [], remote: [] };
  private readonly partials: Partial<Record<TranscriptSource, TranscriptSegment>> = {};

  upsert(segment: TranscriptSegment): TranscriptUpdate {
    const normalized = { ...segment, text: normalizeTranscriptText(segment.text) };
    if (normalized.final) {
      delete this.partials[normalized.source];
      const list = this.finals[normalized.source];
      const existingIndex = list.findIndex((item) => item.id === normalized.id);
      if (existingIndex >= 0) list[existingIndex] = normalized;
      else if (!list.some((item) => item.text === normalized.text && item.endMs === normalized.endMs)) list.push(normalized);
      list.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    } else {
      this.partials[normalized.source] = normalized;
    }
    return { segment: normalized, snapshot: this.snapshot(normalized.source) };
  }

  snapshot(source: TranscriptSource): TranscriptSnapshot {
    const partial = this.partials[source];
    return { source, final: [...this.finals[source]], ...(partial ? { partial } : {}) };
  }

  history(source: TranscriptSource): TranscriptSegment[] {
    return [...this.finals[source]];
  }

  clear(source?: TranscriptSource): void {
    if (source) {
      this.finals[source] = [];
      delete this.partials[source];
      return;
    }
    this.finals.mic = [];
    this.finals.remote = [];
    delete this.partials.mic;
    delete this.partials.remote;
  }
}

export interface PcmQueueStats {
  queuedBytes: number;
  queuedPackets: number;
  droppedPackets: number;
}

export class PcmBackpressureQueue {
  private readonly packets: Uint8Array[] = [];
  private queuedBytes = 0;
  private droppedPackets = 0;

  constructor(private readonly maxBytes = 192_000) {}

  push(packet: Uint8Array): PcmQueueStats {
    if (packet.byteLength > this.maxBytes) {
      this.droppedPackets += 1;
      return this.currentStats();
    }
    this.packets.push(packet);
    this.queuedBytes += packet.byteLength;
    while (this.queuedBytes > this.maxBytes) {
      const oldest = this.packets.shift();
      if (!oldest) break;
      this.queuedBytes -= oldest.byteLength;
      this.droppedPackets += 1;
    }
    return this.currentStats();
  }

  shift(): Uint8Array | undefined {
    const packet = this.packets.shift();
    if (packet) this.queuedBytes -= packet.byteLength;
    return packet;
  }

  get length(): number { return this.packets.length; }
  get stats(): PcmQueueStats { return this.currentStats(); }

  private currentStats(): PcmQueueStats {
    return { queuedBytes: this.queuedBytes, queuedPackets: this.packets.length, droppedPackets: this.droppedPackets };
  }

  clear(): void {
    this.packets.length = 0;
    this.queuedBytes = 0;
  }
}
