import { describe, expect, it } from "vitest";
import { AnswerScheduler, ClaimGate, QuestionDetector2, TechnicalAccuracyGuard, type AnswerSchedulerMetrics } from "@interview-copilot/shared";
import { SqliteDatabase } from "./database";
import { OverlaySettingsStore } from "./settings-store";

interface CoreBehaviorSnapshot {
  detected: ReturnType<QuestionDetector2["analyzeSync"]>;
  scheduler: { active: AnswerScheduler["active"]; queue: AnswerScheduler["queue"]; metrics: AnswerSchedulerMetrics };
  claimDecision: ReturnType<ClaimGate["check"]>;
  technicalDecision: ReturnType<TechnicalAccuracyGuard["check"]>;
  answerText: string;
}

function captureCoreSnapshot(scheduler: AnswerScheduler, answerText: string): CoreBehaviorSnapshot {
  return {
    detected: new QuestionDetector2().analyzeSync("如果通信任务持有互斥锁，导致请求阻塞，应该怎么排查？", "", true),
    scheduler: { active: scheduler.active, queue: scheduler.queue, metrics: scheduler.metrics() },
    claimDecision: new ClaimGate().check({ question: "分享一次排查经历", answer: "我会先确认现象，再通过日志和回归测试定位。" }),
    technicalDecision: new TechnicalAccuracyGuard().check({ question: "DMA 有什么作用？", answer: "DMA 可以减少 CPU 搬运数据的开销。" }),
    answerText
  };
}

describe("overlay core isolation", () => {
  it("changes only display settings while detector, scheduler, guard results, and answer text stay stable", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const scheduler = new AnswerScheduler();
      scheduler.request({ id: "question-1", text: "如果通信任务持有互斥锁，导致请求阻塞，应该怎么排查？", groupId: "group-1" }, { now: 1 });
      scheduler.observeOutput("先确认现象，再检查日志。");
      scheduler.request({ id: "question-2", text: "还要看哪些边界？", groupId: "group-1", relationType: "PARALLEL_SUBQUESTION" }, { now: 2 });
      const answerText = "先确认现象，再检查日志。";
      const settings = new OverlaySettingsStore(database);
      const before = captureCoreSnapshot(scheduler, answerText);

      settings.setPreferences({
        questionWindow: { x: 80, y: 120, width: 960, height: 1_100, fontSize: 32, backgroundOpacity: 0, textOpacity: 1 },
        answerWindow: { x: 1_100, y: 120, width: 1_600, height: 1_200, fontSize: 40, backgroundOpacity: 0 },
        controlBar: { x: 12, y: 18, positionMode: "custom", orientation: "vertical" },
        appearance: { mode: "text_only", blur: 0, radius: 0, shadow: false, border: false, textShadow: "soft", textOutline: 0 },
        behavior: { interactionMode: "click_through", wheelRouting: "overlay_under_cursor", temporaryInteractionModifier: "ctrl" }
      });
      const after = captureCoreSnapshot(scheduler, answerText);

      expect(after).toEqual(before);
      expect(settings.getPreferences().appearance.mode).toBe("text_only");
    } finally {
      database.close();
    }
  });
});
