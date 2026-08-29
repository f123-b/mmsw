export const INTERVIEW_STARTUP_EVENTS = [
  "START_BUTTON_CLICK",
  "PREFLIGHT_BEGIN",
  "PREFLIGHT_END",
  "LOCAL_ASR_PREPARE_BEGIN",
  "LOCAL_ASR_PREPARE_END",
  "COORDINATOR_START_BEGIN",
  "AUDIO_READY",
  "ASR_READY",
  "OVERLAY_PREPARE_BEGIN",
  "QUESTION_RENDERER_READY",
  "ANSWER_RENDERER_READY",
  "CONTROL_RENDERER_READY",
  "OVERLAY_SHOW_REQUEST",
  "QUESTION_VISIBLE",
  "ANSWER_VISIBLE",
  "CONTROL_VISIBLE",
  "INTERVIEW_READY"
] as const;

export type InterviewStartupEvent = typeof INTERVIEW_STARTUP_EVENTS[number];

export interface InterviewStartupTimingSnapshot {
  startedAt: number;
  completedAt?: number;
  totalMs?: number;
  marks: Partial<Record<InterviewStartupEvent, number>>;
  durations: {
    preflightMs?: number;
    asrPrepareMs?: number;
    audioMs?: number;
    questionRendererMs?: number;
    answerRendererMs?: number;
    controlRendererMs?: number;
    overlayShowMs?: number;
    totalMs?: number;
  };
}

/** Small, dependency-free trace used by both production logs and regression tests. */
export class InterviewStartupTiming {
  private readonly marksValue: Partial<Record<InterviewStartupEvent, number>> = {};
  private completedAt: number | undefined;

  constructor(private readonly now: () => number = () => performance.now(), startedAt = now()) {
    this.marksValue.START_BUTTON_CLICK = startedAt;
  }

  mark(event: InterviewStartupEvent, at = this.now()): number {
    if (this.marksValue[event] === undefined) this.marksValue[event] = at;
    return this.marksValue[event] ?? at;
  }

  complete(at = this.now()): InterviewStartupTimingSnapshot {
    this.completedAt = at;
    this.mark("INTERVIEW_READY", at);
    return this.snapshot();
  }

  snapshot(): InterviewStartupTimingSnapshot {
    const mark = (event: InterviewStartupEvent): number | undefined => this.marksValue[event];
    const duration = (from: InterviewStartupEvent, to: InterviewStartupEvent): number | undefined => {
      const start = mark(from);
      const end = mark(to);
      return start === undefined || end === undefined ? undefined : Math.max(0, end - start);
    };
    const totalMs = this.completedAt === undefined ? undefined : Math.max(0, this.completedAt - this.marksValue.START_BUTTON_CLICK!);
    return {
      startedAt: this.marksValue.START_BUTTON_CLICK!,
      ...(this.completedAt === undefined ? {} : { completedAt: this.completedAt }),
      ...(totalMs === undefined ? {} : { totalMs }),
      marks: { ...this.marksValue },
      durations: {
        preflightMs: duration("PREFLIGHT_BEGIN", "PREFLIGHT_END"),
        asrPrepareMs: duration("LOCAL_ASR_PREPARE_BEGIN", "LOCAL_ASR_PREPARE_END"),
        audioMs: duration("COORDINATOR_START_BEGIN", "AUDIO_READY"),
        questionRendererMs: duration("OVERLAY_PREPARE_BEGIN", "QUESTION_RENDERER_READY"),
        answerRendererMs: duration("OVERLAY_PREPARE_BEGIN", "ANSWER_RENDERER_READY"),
        controlRendererMs: duration("OVERLAY_PREPARE_BEGIN", "CONTROL_RENDERER_READY"),
        overlayShowMs: duration("OVERLAY_SHOW_REQUEST", "QUESTION_VISIBLE"),
        ...(totalMs === undefined ? {} : { totalMs })
      }
    };
  }
}
