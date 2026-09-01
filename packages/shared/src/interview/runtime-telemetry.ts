export interface RuntimeInterviewTelemetryRecord {
  speechAct?: string;
  utteranceCompleteness?: string;
  activeProjectId?: string;
  activeProjectConfidence?: number;
  topic?: string;
  questionRelation?: string;
  answerSourceMode?: string;
  projectQaMatch?: string;
  projectFactCount?: number;
  sessionEvidenceCount?: number;
  claimGateDecision?: string;
  blockedClaimCount?: number;
  firstTokenMs?: number;
  answerTotalMs?: number;
  questionDebounceMs?: number;
}

export interface RuntimeInterviewTelemetrySnapshot extends RuntimeInterviewTelemetryRecord {
  updatedAt: number;
}

/** Bounded latest-value telemetry; it never blocks the answer path. */
export class RuntimeInterviewTelemetry {
  private value: RuntimeInterviewTelemetrySnapshot = { updatedAt: 0 };

  reset(): void { this.value = { updatedAt: 0 }; }
  record(fields: RuntimeInterviewTelemetryRecord, now = Date.now()): RuntimeInterviewTelemetrySnapshot { this.value = { ...this.value, ...fields, updatedAt: now }; return this.snapshot(); }
  snapshot(): RuntimeInterviewTelemetrySnapshot { return { ...this.value }; }
}
