import { describe, expect, it } from "vitest";
import fixtures from "../../../tests/fixtures/real-interview-regression-20260824.json";
import {
  ContextAnchorResolver,
  ContextAnchorStore,
  QuestionDetector2,
  SpeechActClassifier,
  TranscriptAggregator,
  classifyAnswerQuestion,
  resolveContextualTerminology,
  type InterviewSpeechAct
} from "./index";
import { QuestionAnalyzer, routeKnowledge } from "./knowledge/retriever";

interface RealInterviewFixture {
  id: string;
  text: string;
  context?: string;
  sequence?: string[];
  parentCase?: string;
  expectedSpeechAct: InterviewSpeechAct;
  shouldAnswer: boolean;
  canonicalContains?: string;
  canonicalNotContains?: string;
  codeContext?: boolean;
  codeRequest?: boolean;
  quantity?: boolean;
  meta?: boolean;
  ack?: boolean;
  contextIsolation?: boolean;
  standalone?: boolean;
}

interface Evaluation {
  fixture: RealInterviewFixture;
  speechAct: InterviewSpeechAct;
  shouldAnswer: boolean;
  canonicalQuestion: string;
  parentQuestionId?: string;
  routeKind: string;
  useProjectMemory: boolean;
  corrections: ReturnType<typeof resolveContextualTerminology>["corrections"];
  codeContext: boolean;
}

function segment(id: string, text: string, startMs: number, endMs: number) {
  return { id, source: "remote" as const, text, startMs, endMs, final: true as const, confidence: 0.98 };
}

describe("real interview regression benchmark", () => {
  it("runs raw ASR through terminology, aggregation, speech acts, anchors, routing and detection", () => {
    const all = fixtures as RealInterviewFixture[];
    const evaluations: Evaluation[] = [];
    const resolver = new ContextAnchorResolver();
    const speechClassifier = new SpeechActClassifier();
    const detector = new QuestionDetector2();
    const questionAnalyzer = new QuestionAnalyzer();

    for (const fixture of all) {
      let now = 1_000;
      const aggregator = new TranscriptAggregator();
      const anchors = new ContextAnchorStore(() => now);
      const preCorrections: Evaluation["corrections"] = [];
      const sequence = fixture.sequence ?? [fixture.text];
      const segmentCaseIds = sequence.map((_text, index) => index === 0 && fixture.parentCase ? fixture.parentCase : fixture.id);
      const completed: Array<{ text: string; id: string }> = [];

      const processUtterance = (utterance: { text: string; id: string }, caseId: string, recordEvaluation = true): void => {
        const currentContext = anchors.snapshot(now);
        const contextual = resolveContextualTerminology(utterance.text, { contextText: fixture.context, topics: [currentContext.currentTopic].filter((topic): topic is string => Boolean(topic)) });
        const speech = speechClassifier.classify(contextual.text, {
          currentTopic: currentContext.currentTopic,
          latestAnchor: currentContext.latestAnchor,
          pendingCodeContext: Boolean(currentContext.pendingCodeContext),
          now
        });
        if (!speech.shouldAnswer) {
          if (speech.speechAct === "TOPIC_ANCHOR" || speech.codeContext) {
            const anchor = anchors.addAnchor({ text: contextual.text, speechAct: speech.codeContext ? "CODE_CONTEXT" : "TOPIC_ANCHOR", topic: speech.topic, entities: speech.entities, confidence: speech.confidence, createdAt: now, ttlMs: speech.codeContext ? 12_000 : 7_000 });
            if (speech.speechAct === "TOPIC_ANCHOR" && !speech.codeContext) anchors.addAnchor({ text: anchor.text, speechAct: "TOPIC_ANCHOR", topic: anchor.topic, entities: anchor.entities, confidence: anchor.confidence, createdAt: now, ttlMs: 7_000 });
          }
          if (recordEvaluation) evaluations.push({ fixture: caseId === fixture.id ? fixture : { ...fixture, id: caseId }, speechAct: speech.speechAct, shouldAnswer: false, canonicalQuestion: contextual.text, routeKind: "not_question", useProjectMemory: false, corrections: contextual.corrections, codeContext: Boolean(speech.codeContext) });
          return;
        }
        const resolved = resolver.resolve({ text: contextual.text, speechAct: speech.speechAct, anchors: currentContext });
        const analysis = detector.analyzeSync(resolved.canonicalQuestion, fixture.context ?? "", true, { latestAnchor: currentContext.latestAnchor, pendingCodeContext: Boolean(currentContext.pendingCodeContext) });
        const shouldAnswer = speech.shouldAnswer && analysis.isQuestion;
        const routeKind = classifyAnswerQuestion(resolved.canonicalQuestion, speech.speechAct === "FOLLOW_UP" ? "follow-up" : undefined);
        const knowledgeRoute = routeKnowledge(questionAnalyzer.analyze(resolved.canonicalQuestion));
        const questionId = `q-${caseId}`;
        if (shouldAnswer) anchors.recordConfirmedQuestion({ id: questionId, text: resolved.canonicalQuestion, confidence: speech.confidence, createdAt: now });
        if (recordEvaluation) evaluations.push({ fixture: caseId === fixture.id ? fixture : { ...fixture, id: caseId }, speechAct: speech.speechAct, shouldAnswer, canonicalQuestion: resolved.canonicalQuestion, ...(resolved.parentQuestionId ? { parentQuestionId: resolved.parentQuestionId } : {}), routeKind, useProjectMemory: knowledgeRoute.useProjectMemory, corrections: [...preCorrections, ...contextual.corrections], codeContext: Boolean(speech.codeContext) });
      };

      for (let index = 0; index < sequence.length; index += 1) {
        const rawText = sequence[index];
        const rawContext = resolveContextualTerminology(rawText, { contextText: fixture.context });
        preCorrections.push(...rawContext.corrections);
        now += 1_000;
        aggregator.push(segment(`${fixture.id}-${index}`, rawContext.text, index === 0 ? 0 : 2_500, index === 0 ? 700 : 3_200), now);
        for (const finished of aggregator.drainCompleted("remote")) completed.push({ text: finished.text, id: finished.id });
      }
      for (const finished of aggregator.flush("remote", now + 500)) completed.push({ text: finished.text, id: finished.id });
      for (const [index, utterance] of completed.entries()) processUtterance(utterance, segmentCaseIds[Math.min(index, segmentCaseIds.length - 1)] ?? fixture.id, !(sequence.length > 1 && index === 0));
    }

    const byFixture = new Map<string, Evaluation>();
    for (const evaluation of evaluations) byFixture.set(evaluation.fixture.id, evaluation);
    const expected = all.map((fixture) => byFixture.get(fixture.id)).filter((item): item is Evaluation => Boolean(item));
    const answerable = expected.filter((item) => item.fixture.shouldAnswer);
    const predictedAnswerable = expected.filter((item) => item.shouldAnswer);
    const truePositive = expected.filter((item) => item.fixture.shouldAnswer && item.shouldAnswer).length;
    const falsePositive = expected.filter((item) => !item.fixture.shouldAnswer && item.shouldAnswer).length;
    const answerableRecall = truePositive / Math.max(1, answerable.length);
    const answerablePrecision = truePositive / Math.max(1, predictedAnswerable.length);
    const answerRequests = expected.filter((item) => item.fixture.expectedSpeechAct === "ANSWER_REQUEST");
    const codeRequests = expected.filter((item) => item.fixture.codeRequest);
    const topicAnchors = expected.filter((item) => item.fixture.expectedSpeechAct === "TOPIC_ANCHOR");
    const followUps = expected.filter((item) => item.fixture.expectedSpeechAct === "FOLLOW_UP");
    const terminologyCases = expected.filter((item) => item.fixture.canonicalContains || item.fixture.canonicalNotContains);
    const contextCases = expected.filter((item) => item.fixture.contextIsolation);
    const duplicateCount = expected.length - new Set(expected.map((item) => item.canonicalQuestion.replace(/[？?。！!]/g, ""))).size;
    const metrics = {
      samples: expected.length,
      answerableRecall: Number(answerableRecall.toFixed(4)),
      answerablePrecision: Number(answerablePrecision.toFixed(4)),
      answerRequestRecall: Number((answerRequests.filter((item) => item.speechAct === "ANSWER_REQUEST" && item.shouldAnswer).length / Math.max(1, answerRequests.length)).toFixed(4)),
      codeRequestRecall: Number((codeRequests.filter((item) => item.speechAct === "CODE_REQUEST" && item.shouldAnswer).length / Math.max(1, codeRequests.length)).toFixed(4)),
      topicAnchorAccuracy: Number((topicAnchors.filter((item) => item.speechAct === "TOPIC_ANCHOR" && !item.shouldAnswer).length / Math.max(1, topicAnchors.length)).toFixed(4)),
      followUpParentAccuracy: Number((followUps.filter((item) => item.parentQuestionId === `q-${item.fixture.parentCase}`).length / Math.max(1, followUps.length)).toFixed(4)),
      terminologyCorrectionAccuracy: Number((terminologyCases.filter((item) => (item.fixture.canonicalContains ? item.canonicalQuestion.includes(item.fixture.canonicalContains) && item.corrections.some((correction) => correction.canonical === item.fixture.canonicalContains) : !item.canonicalQuestion.includes(item.fixture.canonicalNotContains!))).length / Math.max(1, terminologyCases.length)).toFixed(4)),
      metaFalsePositiveRate: Number((expected.filter((item) => item.fixture.meta && item.shouldAnswer).length / Math.max(1, expected.filter((item) => item.fixture.meta).length)).toFixed(4)),
      acknowledgementFalsePositiveRate: Number((expected.filter((item) => item.fixture.ack && item.shouldAnswer).length / Math.max(1, expected.filter((item) => item.fixture.ack).length)).toFixed(4)),
      duplicateRate: Number((duplicateCount / Math.max(1, expected.length)).toFixed(4)),
      wrongContextRate: Number((contextCases.filter((item) => item.useProjectMemory).length / Math.max(1, contextCases.length)).toFixed(4)),
      falsePositive,
      terminologySamples: terminologyCases.map((item) => ({ id: item.fixture.id, raw: item.fixture.text, canonical: item.canonicalQuestion, corrections: item.corrections }))
    };
    console.log(`REAL_INTERVIEW_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(metrics.answerableRecall).toBeGreaterThanOrEqual(0.95);
    expect(metrics.answerablePrecision).toBeGreaterThanOrEqual(0.95);
    expect(metrics.answerRequestRecall).toBeGreaterThanOrEqual(0.9);
    expect(metrics.codeRequestRecall).toBe(1);
    expect(metrics.topicAnchorAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(metrics.followUpParentAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(metrics.terminologyCorrectionAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(metrics.metaFalsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(metrics.acknowledgementFalsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(metrics.duplicateRate).toBeLessThanOrEqual(0.05);
    expect(metrics.wrongContextRate).toBeLessThanOrEqual(0.05);
    expect(expected.filter((item) => item.fixture.expectedSpeechAct !== item.speechAct), JSON.stringify(expected.map((item) => ({ id: item.fixture.id, expected: item.fixture.expectedSpeechAct, actual: item.speechAct, canonical: item.canonicalQuestion })))).toHaveLength(0);
  });
});
