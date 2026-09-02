import type { PendingQuestionLedgerItem, QuestionFrame } from "./question-frame";

function cloneFrame(frame: QuestionFrame): QuestionFrame {
  return { ...frame, segmentIds: [...frame.segmentIds], rawSegments: [...frame.rawSegments], subQuestions: frame.subQuestions.map((slot) => ({ ...slot })), entities: { ...frame.entities, projects: [...frame.entities.projects], components: [...frame.entities.components], technologies: [...frame.entities.technologies], concepts: [...frame.entities.concepts] }, references: frame.references.map((item) => ({ ...item, evidence: [...item.evidence] })), confidence: { ...frame.confidence }, unresolvedSlots: [...frame.unresolvedSlots] };
}

/** Retains low-confidence questions so later ASR/context can complete them. */
export class QuestionPendingLedger {
  private readonly values = new Map<string, PendingQuestionLedgerItem>();

  get size(): number { return this.values.size; }
  list(now = Date.now(), ttlMs = 15_000): PendingQuestionLedgerItem[] {
    this.expire(now, ttlMs);
    return [...this.values.values()].map((item) => ({ ...item, frame: cloneFrame(item.frame), unresolvedSlots: [...item.unresolvedSlots] }));
  }
  upsert(frame: QuestionFrame, now = Date.now(), status: PendingQuestionLedgerItem["status"] = "WAITING_CONTEXT"): PendingQuestionLedgerItem {
    const existing = this.values.get(frame.id);
    const item: PendingQuestionLedgerItem = {
      frame: cloneFrame(frame),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastUpdatedAt: now,
      unresolvedSlots: [...frame.unresolvedSlots],
      status
    };
    this.values.set(frame.id, item);
    return { ...item, frame: cloneFrame(item.frame), unresolvedSlots: [...item.unresolvedSlots] };
  }
  append(frameId: string, frame: QuestionFrame, now = Date.now()): PendingQuestionLedgerItem | undefined {
    const existing = this.values.get(frameId);
    if (!existing) return undefined;
    const merged = { ...frame, id: frameId, segmentIds: [...new Set([...existing.frame.segmentIds, ...frame.segmentIds])], rawSegments: [...existing.frame.rawSegments, ...frame.rawSegments] };
    return this.upsert(merged, now, existing.status);
  }
  rewrite(frameId: string, frame: QuestionFrame, now = Date.now(), status?: PendingQuestionLedgerItem["status"]): PendingQuestionLedgerItem {
    const existing = this.values.get(frameId);
    const rewritten = { ...frame, id: frameId };
    return this.upsert(rewritten, now, status ?? existing?.status ?? "WAITING_CONTEXT");
  }
  split(frameId: string, frames: QuestionFrame[], now = Date.now()): PendingQuestionLedgerItem[] {
    this.values.delete(frameId);
    return frames.map((frame, index) => this.upsert({ ...frame, id: `${frame.id}:split-${index + 1}` }, now, "READY"));
  }
  commit(frameId: string): QuestionFrame | undefined { return this.remove(frameId); }
  remove(frameId: string): QuestionFrame | undefined {
    const value = this.values.get(frameId)?.frame;
    this.values.delete(frameId);
    return value ? cloneFrame(value) : undefined;
  }
  clear(): void { this.values.clear(); }
  expire(now = Date.now(), ttlMs = 15_000): void {
    for (const [id, item] of this.values) if (now - item.lastUpdatedAt > ttlMs) {
      item.expiryReason = "context-window-expired";
      this.values.delete(id);
    }
  }
}
