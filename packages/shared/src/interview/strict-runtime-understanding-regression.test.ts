import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerScheduler,
  ContextAnchorResolver,
  ContextAnchorStore,
  PendingQuestionDraftAssembler,
  QuestionGroupManager,
  QuestionDetector2,
  SpeechActClassifier,
  TurnBuilder,
  decideSemanticAnswerability,
  decideTurnCompletion,
  detectTopicBoundary,
  type QuestionCandidate
} from "../index";

function segment(id: string, text: string, startMs: number): TranscriptSegment {
  return { id, source: "remote", text, startMs, endMs: startMs + 500, final: true };
}

describe("strict runtime interview understanding replay", () => {
  it("keeps T0-T4 in the intended groups/tasks while preserving late context", () => {
    const assembler = new PendingQuestionDraftAssembler();
    const detector = new QuestionDetector2();
    const speech = new SpeechActClassifier();
    let now = 0;
    const anchors = new ContextAnchorStore(() => now);
    const resolver = new ContextAnchorResolver();
    const groups = new QuestionGroupManager(new TurnBuilder());
    const scheduler = new AnswerScheduler();
    const expectedGroups = ["T1", "T2", "T3", "T4"];
    const groupByCase = new Map<string, string>();
    const answerTasks: string[] = [];
    const failures: string[] = [];
    let currentCase = "";
    let expectedMultiSegment = 0;
    let multiSegmentCovered = 0;
    let expectedStyles = 0;
    let attachedStyles = 0;
    let expectedExamples = 0;
    let attachedExamples = 0;
    let expectedContextFollowUps = 0;
    let attachedContextFollowUps = 0;

    const attachStyle = (text: string): void => {
      expectedStyles += 1;
      const group = groups.list().filter((item) => item.displayable).at(-1);
      if (!group) return;
      const id = `style-${expectedStyles}`;
      const turn = new TurnBuilder().build({ id: `turn-${id}`, source: "remote", text, segmentIds: [id], startMs: now, endMs: now + 50 });
      const style: QuestionCandidate = { id, text, confidence: "high", score: 1, source: "rules", detectedAt: now, status: "confirmed", shouldAnswer: false, answerable: false, speechAct: "INSTRUCTION_MODIFIER", answerabilityState: "STYLE_ONLY" };
      const result = groups.add({ turn, question: style, relationType: "ANSWER_CONSTRAINT", now });
      if (result.group.id === group.id && result.item.itemType === "ANSWER_CONSTRAINT") attachedStyles += 1;
    };

    const processDraft = (caseId: string): void => {
      const draft = assembler.finalize(now);
      if (!draft) return;
      const text = assembler.canonicalText(draft);
      const anchorSnapshot = anchors.snapshot(now);
      const completion = decideTurnCompletion(text, { currentTopic: anchorSnapshot.currentTopic });
      const analysis = detector.analyzeSync(text, anchorSnapshot.currentTopic ?? "", true, {
        latestAnchor: anchorSnapshot.latestAnchor,
        recentTranscript: anchorSnapshot.lastConfirmedQuestion ? [anchorSnapshot.lastConfirmedQuestion.text] : []
      });
      if (!analysis.isQuestion) return;
      const act = speech.classify(text, { currentTopic: anchorSnapshot.currentTopic, latestAnchor: anchorSnapshot.latestAnchor });
      const resolved = resolver.resolve({ text, speechAct: act.speechAct, anchors: anchorSnapshot });
      const turn = new TurnBuilder().build({ id: `turn-${caseId}-${now}`, source: "remote", text, segmentIds: draft.segmentIds, startMs: Math.min(...draft.rawSegments.map((item) => item.segment.startMs)), endMs: Math.max(...draft.rawSegments.map((item) => item.segment.endMs)), finalizedAt: now });
      const question: QuestionCandidate = {
        id: `question-${caseId}-${now}`,
        text,
        confidence: "high",
        score: analysis.score.finalScore,
        source: "extractor",
        detectedAt: now,
        status: "confirmed",
        shouldAnswer: true,
        answerable: true,
        speechAct: analysis.speechAct,
        detectionType: analysis.type,
        answerabilityState: analysis.answerabilityState,
        contextRelation: resolved.contextRelation,
        topic: resolved.topic,
        canonicalQuestion: text,
        canonicalText: text,
        normalizedText: text,
        utteranceId: turn.id,
        turnId: turn.id,
        segmentIds: [...draft.segmentIds]
      };
      const result = groups.add({ turn, question, now });
      if (!result.displayable || !result.item.answerable) {
        failures.push(`${caseId}: non-displayable answerable draft (${completion.state})`);
        return;
      }
      groupByCase.set(caseId, result.group.id);
      if (draft.segmentIds.length > 1) {
        expectedMultiSegment += 1;
        if (result.group.id && draft.segmentIds.length >= 2) multiSegmentCovered += 1;
      }
      const scheduled = scheduler.request({ id: question.id, text: question.text, groupId: result.group.id, relationType: question.relationType }, { now, groupId: result.group.id });
      if (scheduled.action === "start") {
        answerTasks.push(`${caseId}:${result.group.id}`);
        scheduler.complete(question.id, { activateNext: false });
        groups.mark(question.id, "answered");
        anchors.recordConfirmedQuestion({ id: question.id, text, topic: resolved.topic, createdAt: now });
      } else {
        failures.push(`${caseId}: scheduler action ${scheduled.action}`);
      }
    };

    const add = (caseId: string, id: string, text: string, at: number, options: { contextualFollowUp?: boolean } = {}): void => {
      now = at;
      currentCase = caseId;
      const context = anchors.snapshot(now);
      const semantic = decideSemanticAnswerability(text, { currentTopic: context.currentTopic, latestQuestionText: context.lastConfirmedQuestion?.text, hasRecentQuestion: Boolean(context.lastConfirmedQuestion) });
      if (semantic.state === "STYLE_ONLY" && groups.list().some((group) => group.displayable)) {
        attachStyle(text);
        return;
      }
      if (assembler.current && assembler.shouldFinalize(now)) processDraft(currentCase);
      const update = assembler.add(segment(id, text, at), now, options);
      if (/^(?:比如|例如)/iu.test(text.trim())) {
        expectedExamples += 1;
        const group = groups.list().filter((item) => item.displayable).at(-1);
        if (update.late && group) {
          const fragment: QuestionCandidate = { id: `example-${id}`, text, confidence: "high", score: 1, source: "rules", detectedAt: now, status: "confirmed", shouldAnswer: false, answerable: false, speechAct: "STATEMENT", answerabilityState: "INCOMPLETE" };
          const turn = new TurnBuilder().build({ id: `turn-example-${id}`, source: "remote", text, segmentIds: [id], startMs: at, endMs: at + 50 });
          const result = groups.add({ turn, question: fragment, relationType: "EXAMPLE", now });
          if (result.group.id === group.id && result.item.itemType === "EXAMPLE") attachedExamples += 1;
        }
      }
      if (options.contextualFollowUp) {
        expectedContextFollowUps += 1;
        if (update.reason === "context-follow-up-reopened-recent-question") attachedContextFollowUps += 1;
      }
      if (assembler.current && assembler.shouldFinalize(now)) processDraft(currentCase);
    };

    // T0: a polite request without a subject must produce no task.
    add("T0", "t0", "来个基础的，你说说。", 0);
    now = 800;
    processDraft("T0");

    add("T1", "t1", "I2C总线是怎么实现多设备通信的？", 1_000);
    now = 1_220;
    processDraft("T1");
    add("T1", "t1-style", "大概讲讲通信和仲裁就行。", 1_400);

    add("T2", "t2", "说说 RTOS 任务调度和优先级反转怎么处理？", 4_000);
    now = 4_220;
    processDraft("T2");
    add("T2", "t2-style", "简单说说就行。", 6_000);

    // T3: setup/support/nucleus are deliberately separated by seconds.
    add("T3", "t3-setup", "如果系统间歇性卡死", 7_000);
    now = 7_800;
    processDraft("T3");
    add("T3", "t3-support", "日志也没刷出来", 9_000);
    now = 9_800;
    processDraft("T3");
    add("T3", "t3-nucleus", "你第一反应会怎么入手排查？", 15_000);
    now = 15_220;
    processDraft("T3");
    add("T3", "t3-example", "比如会先看中断、看门狗还是外设状态。", 15_400);
    add("T3", "t3-style", "简单说说思路就行。", 15_500);

    // T4: the first final is intentionally dangling; the later contextual
    // choice reopens that draft instead of producing a second task.
    add("T4", "t4-dangling", "你说说 UART 和 SPI 的主要区别，以及什么时候。", 17_000);
    now = 17_760;
    processDraft("T4");
    add("T4", "t4-follow-up", "你会更倾向于用哪一个？", 18_100, { contextualFollowUp: true });
    now = 18_320;
    processDraft("T4");

    const visibleGroups = groups.list().filter((group) => group.displayable);
    const substantiveGroups = new Set(groupByCase.values());
    const metrics = {
      expectedSubstantiveGroups: expectedGroups.length,
      substantiveGroups: substantiveGroups.size,
      answerTasks: answerTasks.length,
      questionRecall: substantiveGroups.size / expectedGroups.length,
      falsePositiveQuestions: groupByCase.has("T0") ? 1 : 0,
      falseNegativeQuestions: expectedGroups.filter((caseId) => !groupByCase.has(caseId)).length,
      multiSegmentCoverage: multiSegmentCovered / Math.max(1, expectedMultiSegment),
      constraintCoverage: attachedStyles / Math.max(1, expectedStyles),
      styleConstraintAttachRate: attachedStyles / Math.max(1, expectedStyles),
      exampleCoverage: attachedExamples / Math.max(1, expectedExamples),
      contextFollowUpAttachRate: attachedContextFollowUps / Math.max(1, expectedContextFollowUps),
      orphanSetupFalseAnswerRate: answerTasks.filter((task) => task.startsWith("T0:")).length,
      duplicateAnswerRate: answerTasks.length > substantiveGroups.size ? (answerTasks.length - substantiveGroups.size) / answerTasks.length : 0,
      semanticSlotCoverage: visibleGroups.reduce((sum, group) => sum + group.slots.filter((slot) => slot.status !== "pending").length, 0) / Math.max(1, visibleGroups.reduce((sum, group) => sum + group.slots.length, 0)),
      failures
    };
    console.log(`REALTIME_INTERVIEW_UNDERSTANDING_REPLAY ${JSON.stringify(metrics)}`);
    expect(metrics.failures).toEqual([]);
    expect(metrics.falsePositiveQuestions).toBe(0);
    expect(metrics.falseNegativeQuestions).toBe(0);
    expect(metrics.substantiveGroups).toBe(4);
    expect(metrics.answerTasks).toBe(4);
    expect(metrics.multiSegmentCoverage).toBe(1);
    expect(metrics.constraintCoverage).toBe(1);
    expect(metrics.exampleCoverage).toBe(1);
    expect(metrics.contextFollowUpAttachRate).toBe(1);
    expect(metrics.duplicateAnswerRate).toBe(0);
    expect(metrics.orphanSetupFalseAnswerRate).toBe(0);
  });

  it("keeps the new local understanding path below the live-path budget", () => {
    const timings: number[] = [];
    const gateTimings: number[] = [];
    const assemblyTimings: number[] = [];
    const detector = new QuestionDetector2();
    const assembler = new PendingQuestionDraftAssembler();
    const text = "说说 I2C 和 SPI 的主要区别，以及什么时候你会更倾向于用哪一个？";
    const percentile = (values: number[], p: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    };
    for (let index = 0; index < 1_100; index += 1) {
      const started = performance.now();
      decideSemanticAnswerability(text, { currentTopic: "I2C", latestQuestionText: "I2C问题", hasRecentQuestion: true });
      detectTopicBoundary({ previousText: "I2C问题", previousTopic: "I2C", currentText: text });
      detector.analyzeSync(text, "I2C", true, { latestAnchor: { text: "I2C问题", topic: "I2C", speechAct: "QUESTION" } });
      timings.push(performance.now() - started);
      const gateStarted = performance.now();
      decideTurnCompletion(text, { currentTopic: "I2C" });
      gateTimings.push(performance.now() - gateStarted);
      const assemblyStarted = performance.now();
      const local = new PendingQuestionDraftAssembler();
      local.add(segment(`perf-${index}`, text, index), index);
      assemblyTimings.push(performance.now() - assemblyStarted);
      assembler.reset();
    }
    const metrics = { allNewPathP95Ms: percentile(timings, 0.95), completionGateP95Ms: percentile(gateTimings, 0.95), assemblyP95Ms: percentile(assemblyTimings, 0.95) };
    console.log(`REALTIME_INTERVIEW_UNDERSTANDING_PERF ${JSON.stringify(metrics)}`);
    expect(metrics.allNewPathP95Ms).toBeLessThan(20);
    expect(metrics.completionGateP95Ms).toBeLessThan(5);
    expect(metrics.assemblyP95Ms).toBeLessThan(10);
  });
});
