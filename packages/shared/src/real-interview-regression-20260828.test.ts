import { describe, expect, it } from "vitest";
import fixtures from "../../../tests/fixtures/real-interview-regression-20260828.json";
import {
  ContextAnchorResolver,
  ContextAnchorStore,
  InterviewHistoryStore,
  SpokenAnswerFormatter,
  TechnicalAccuracyGuard,
  classifyQuestionSemanticFrame,
  decomposeQuestion,
  detectTopicBoundary,
  enforceHrProfilePolicy,
  hasStandaloneTopicSubject,
  matchCoreTechnicalQa,
  resolveContextualTerminology,
  TranscriptAggregator,
  type InterviewSpeechAct
} from "./index";

interface RegressionFixture {
  id: string;
  text: string;
  context?: string;
  previousText?: string;
  previousTopic?: string;
  currentTopic?: string;
  answer?: string;
  segments?: string[];
  expected: {
    canonicalContains?: string;
    canonicalNotContains?: string;
    correction?: string;
    noCorrection?: string;
    semanticFrame?: string;
    coreQa?: string;
    firstLineContains?: string;
    topicBoundary?: string;
    currentEntities?: string[];
    contextRelation?: string;
    projectMemory?: boolean;
    slotCount?: number;
    hrReason?: string;
    forbidden?: string;
    formatterNoArtifact?: boolean;
  };
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

describe("real interview regression 2026-08-28", () => {
  it("covers terminology, semantic frames, boundary safety, core QA and output safety", () => {
    const all = fixtures as RegressionFixture[];
    const timings: number[] = [];
    let contextLeaks = 0;
    let standaloneCorrect = 0;
    let standaloneTotal = 0;
    let followUpCorrect = 0;
    let followUpTotal = 0;
    let boundaryCorrect = 0;
    let boundaryTotal = 0;
    let terminologyCorrect = 0;
    let terminologyTotal = 0;
    let falseCorrections = 0;
    let semanticCorrect = 0;
    let semanticTotal = 0;
    let coreHits = 0;
    let coreTotal = 0;
    let coreStrongMatches = 0;
    let coreMatched = 0;
    let projectLeaks = 0;
    let hallucinations = 0;
    let multiSlotCovered = 0;
    let multiSlotTotal = 0;
    let artifactCount = 0;
    const caseResults: Array<Record<string, unknown>> = [];
    const failures: Array<{ id: string; actual: unknown; expected: unknown }> = [];

    for (const fixture of all) {
      const started = performance.now();
      let sourceText = fixture.text;
      if (fixture.segments) {
        const aggregator = new TranscriptAggregator();
        fixture.segments.forEach((text, index) => aggregator.push({ id: `${fixture.id}-segment-${index}`, source: "remote", text, startMs: index * 400, endMs: index * 400 + 200, final: true }, 1_000 + index * 400, text));
        sourceText = aggregator.flush("remote", 2_000)[0]?.rawText ?? sourceText;
      }
      const resolution = resolveContextualTerminology(sourceText, { contextText: fixture.context, previousQuestion: fixture.previousText, topics: [fixture.currentTopic, fixture.previousTopic].filter((value): value is string => Boolean(value)) });
      const expected = fixture.expected;
      caseResults.push({ id: fixture.id, rawText: fixture.text, canonicalText: resolution.canonicalText, semanticFrame: classifyQuestionSemanticFrame(resolution.canonicalText), coreQaQuestionId: matchCoreTechnicalQa(resolution.canonicalText)?.id, terminologyCorrections: resolution.corrections.map((item) => `${item.raw}→${item.canonical}`) });
      if (expected.canonicalContains || expected.canonicalNotContains || expected.correction || expected.noCorrection) {
        terminologyTotal += 1;
        const contains = expected.canonicalContains ? resolution.canonicalText.includes(expected.canonicalContains) : !resolution.canonicalText.includes(expected.canonicalNotContains ?? "\u0000");
        const correction = expected.correction ? resolution.corrections.some((item) => item.canonical === expected.correction) : !resolution.corrections.some((item) => item.canonical === expected.noCorrection);
        if (contains && correction) terminologyCorrect += 1;
        if (expected.noCorrection && resolution.corrections.some((item) => item.canonical === expected.noCorrection)) falseCorrections += 1;
      }
      if (expected.semanticFrame) {
        semanticTotal += 1;
        if (classifyQuestionSemanticFrame(resolution.canonicalText) === expected.semanticFrame) semanticCorrect += 1;
      }
      if (expected.coreQa) {
        coreTotal += 1;
        const card = matchCoreTechnicalQa(resolution.canonicalText);
        if (card) {
          coreMatched += 1;
          if (card.id === expected.coreQa) { coreHits += 1; coreStrongMatches += 1; }
        }
        if (card?.id === expected.coreQa && expected.firstLineContains && !card.shortAnswer.split(/[。！？!?]/)[0]?.includes(expected.firstLineContains)) failures.push({ id: fixture.id, actual: card.shortAnswer, expected: expected.firstLineContains });
      }
      if (expected.topicBoundary) {
        boundaryTotal += 1;
        const boundary = detectTopicBoundary({ previousText: fixture.previousText, previousTopic: fixture.previousTopic, currentTopic: fixture.currentTopic, currentText: resolution.canonicalText });
        if (boundary.relation === expected.topicBoundary && (!expected.currentEntities || JSON.stringify(boundary.currentEntities) === JSON.stringify(expected.currentEntities))) boundaryCorrect += 1;
        if (expected.currentEntities && JSON.stringify(boundary.currentEntities) !== JSON.stringify(expected.currentEntities)) failures.push({ id: fixture.id, actual: boundary.currentEntities, expected: expected.currentEntities });
        if (fixture.id === "boundary-new-can" && hasStandaloneTopicSubject(resolution.canonicalText)) standaloneCorrect += 1;
        if (fixture.id === "boundary-new-can") standaloneTotal += 1;
      }
      if (fixture.id === "boundary-followup") {
        followUpTotal += 1;
        const anchors = new ContextAnchorStore(() => 1_000);
        const parent = anchors.recordConfirmedQuestion({ id: "q-parent", text: fixture.previousText ?? "CAN 总线如何仲裁？", topic: "CAN", createdAt: 1_000 });
        const resolved = new ContextAnchorResolver().resolve({ text: resolution.canonicalText, speechAct: "FOLLOW_UP" as InterviewSpeechAct, anchors: anchors.snapshot(1_500) });
        if (resolved.contextRelation === expected.contextRelation && resolved.parentQuestionId === parent.id) followUpCorrect += 1;
      }
      if (expected.contextRelation && fixture.id !== "boundary-followup") {
        const anchors = new ContextAnchorStore(() => 1_000);
        anchors.recordConfirmedQuestion({ id: "q-parent", text: fixture.previousText ?? "CAN 总线如何仲裁？", topic: fixture.previousTopic, createdAt: 1_000 });
        const resolved = new ContextAnchorResolver().resolve({ text: resolution.canonicalText, speechAct: "FOLLOW_UP" as InterviewSpeechAct, anchors: anchors.snapshot(1_500) });
        if (resolved.contextRelation !== expected.contextRelation) failures.push({ id: fixture.id, actual: resolved.contextRelation, expected: expected.contextRelation });
      }
      if (expected.canonicalNotContains === "FOC" && resolution.canonicalText.includes("FOC")) contextLeaks += 1;
      if (expected.projectMemory === false && /项目|简历|经历/.test(resolution.canonicalText)) projectLeaks += 1;
      if (expected.slotCount) {
        multiSlotTotal += 1;
        const decomposition = decomposeQuestion(resolution.canonicalText);
        if (decomposition.isMultiSlot && decomposition.slots.length === expected.slotCount && decomposition.slots.every((slot) => slot.required)) multiSlotCovered += 1;
      }
      if (expected.hrReason || expected.forbidden) {
        const hr = enforceHrProfilePolicy({ question: resolution.canonicalText, answer: "我期望 15K，也希望了解贵公司的业务。" });
        if (expected.hrReason && hr.reason !== expected.hrReason) failures.push({ id: fixture.id, actual: hr.reason, expected: expected.hrReason });
        if (expected.forbidden && hr.answer.includes(expected.forbidden)) hallucinations += 1;
      }
      if (expected.formatterNoArtifact) {
        const formatted = new SpokenAnswerFormatter().format(fixture.answer ?? "", "NORMAL");
        if (/\$(?:\d+|\{[^}]+\})/.test(formatted)) artifactCount += 1;
      }
      timings.push(performance.now() - started);
    }

    const accuracySamples = all.filter((fixture) => fixture.expected.semanticFrame || fixture.expected.coreQa);
    const technicalChecks = [
      ["++p 和 p++ 有什么区别？", "++p 先取值，p++ 先移动。"],
      ["PWM 中心对齐有什么好处？", "中心对齐 PWM 一定会多一次采样机会。"],
      ["FOC 为什么只采两相电流？", "两相采样必然少一次中断。"],
      ["UDP 可靠吗？", "UDP 绝对不会重传。"]
    ] as const;
    const guard = new TechnicalAccuracyGuard();
    const accuracyViolations = technicalChecks.filter(([question, answer]) => guard.check({ question, answer }).decision === "allow").length;

    const historyLatencies: number[] = [];
    const history = new InterviewHistoryStore();
    const interview = history.createInterview({ profileId: "regression", startedAt: 1, status: "running", language: "zh-CN", automationMode: "AUTO" }, 1);
    history.onChanged(() => historyLatencies.push(0));
    for (let index = 0; index < 20; index += 1) {
      const syncStarted = performance.now();
      history.addQuestion({ interviewId: interview.id, text: `回归问题 ${index}？`, confidence: "high", source: "rules", detectedAt: index + 2, status: "confirmed" });
      historyLatencies[historyLatencies.length - 1] = performance.now() - syncStarted;
    }

    const metrics = {
      samples: all.length,
      ContextLeakRate: contextLeaks / Math.max(1, all.filter((fixture) => fixture.expected.canonicalNotContains === "FOC").length),
      StandaloneQuestionAccuracy: standaloneCorrect / Math.max(1, standaloneTotal),
      FollowUpLinkAccuracy: followUpCorrect / Math.max(1, followUpTotal),
      TopicBoundaryAccuracy: boundaryCorrect / Math.max(1, boundaryTotal),
      TerminologyRepairAccuracy: terminologyCorrect / Math.max(1, terminologyTotal),
      TerminologyFalseCorrectionRate: falseCorrections / Math.max(1, terminologyTotal),
      SemanticFrameAccuracy: semanticCorrect / Math.max(1, semanticTotal),
      CoreQaHitRate: coreHits / Math.max(1, coreTotal),
      CoreQaStrongPrecision: coreStrongMatches / Math.max(1, coreMatched),
      TechnicalAccuracyViolationRate: accuracyViolations / technicalChecks.length,
      GeneralQuestionProjectLeakRate: projectLeaks / Math.max(1, all.filter((fixture) => fixture.expected.projectMemory === false).length),
      PersonalHallucinationRate: hallucinations / Math.max(1, all.filter((fixture) => fixture.expected.hrReason).length),
      MultiSlotCoverageRate: multiSlotCovered / Math.max(1, multiSlotTotal),
      HistorySyncLatencyP95: p95(historyLatencies),
      FormatterArtifactRate: artifactCount / Math.max(1, all.filter((fixture) => fixture.expected.formatterNoArtifact).length),
      processingP95Ms: p95(timings),
      semanticFrameSamples: accuracySamples.length,
      caseResults,
      failures
    };
    console.log(`REAL_INTERVIEW_REGRESSION_20260828 ${JSON.stringify(metrics)}`);
    expect(metrics.ContextLeakRate).toBe(0);
    expect(metrics.StandaloneQuestionAccuracy).toBe(1);
    expect(metrics.FollowUpLinkAccuracy).toBe(1);
    expect(metrics.TopicBoundaryAccuracy).toBe(1);
    expect(metrics.TerminologyRepairAccuracy).toBe(1);
    expect(metrics.TerminologyFalseCorrectionRate).toBe(0);
    expect(metrics.SemanticFrameAccuracy).toBe(1);
    expect(metrics.CoreQaHitRate).toBe(1);
    expect(metrics.CoreQaStrongPrecision).toBe(1);
    expect(metrics.TechnicalAccuracyViolationRate).toBe(0);
    expect(metrics.GeneralQuestionProjectLeakRate).toBe(0);
    expect(metrics.PersonalHallucinationRate).toBe(0);
    expect(metrics.MultiSlotCoverageRate).toBe(1);
    expect(metrics.HistorySyncLatencyP95).toBeLessThan(500);
    expect(metrics.FormatterArtifactRate).toBe(0);
    expect(metrics.processingP95Ms).toBeLessThan(100);
    expect(failures, JSON.stringify(failures)).toHaveLength(0);
  });
});
