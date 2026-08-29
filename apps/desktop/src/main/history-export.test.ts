import { describe, expect, it } from "vitest";
import { analyzeInterview, type InterviewSnapshot } from "@interview-copilot/shared";
import { formatInterviewMarkdown } from "./history-export";

describe("interview history markdown export", () => {
  it("exports metadata, metrics, timeline and diagnostics without changing the snapshot", () => {
    const snapshot: InterviewSnapshot = {
      interview: {
        id: "interview-1",
        profileId: "profile-1",
        projectId: "project-1",
        jobTargetId: "job-1",
        startedAt: 1_000,
        endedAt: 6_000,
        status: "ended",
        language: "zh-CN",
        automationMode: "AUTO",
        createdAt: 1_000
      },
      transcripts: [
        { id: "transcript-1", interviewId: "interview-1", source: "remote", text: "请介绍你的项目", rawText: "请介绍你得项目", canonicalText: "请介绍你的项目", terminologyCorrections: [{ raw: "你得", canonical: "你的", source: "llm" }], startMs: 0, endMs: 1_000, final: true, createdAt: 2_000 },
        { id: "transcript-2", interviewId: "interview-1", source: "mic", text: "这是一个嵌入式项目", startMs: 1_100, endMs: 2_000, final: true, createdAt: 3_000 }
      ],
      questions: [{ id: "question-1", interviewId: "interview-1", text: "请介绍你的项目", confidence: "high", source: "extractor", detectedAt: 2_100, status: "answered", semanticFrame: "personal_fact", contextRelation: "standalone", topic: "嵌入式项目", rawTranscript: "请介绍你得项目", normalizedQuestion: "请介绍你的项目", canonicalQuestion: "请介绍你的项目", terminologyCorrections: [{ raw: "你得", canonical: "你的", source: "llm" }] }],
      answers: [{ id: "answer-1", questionId: "question-1", text: "我负责了驱动和调试。", model: "test-model", mode: "NORMAL", latencyFirstToken: 120, latencyTotal: 800, createdAt: 4_000, finishedAt: 4_800, telemetry: { rawText: "请介绍你得项目", normalizedText: "请介绍你的项目", canonicalText: "请介绍你的项目", answerSourceMode: "project_qa_direct", semanticFrame: "personal_fact", claimGateDecision: "allow", technicalGuardDecision: "allow", historyRevision: 7 } }]
    };
    const before = structuredClone(snapshot);
    const markdown = formatInterviewMarkdown(snapshot, analyzeInterview(snapshot));

    expect(snapshot).toEqual(before);
    expect(markdown).toContain("# 面试记录");
    expect(markdown).toContain("- 记录 ID：interview-1");
    expect(markdown).toContain("- 识别问题：1 个");
    expect(markdown).toContain("### 面试官");
    expect(markdown).toContain("### AI 回答");
    expect(markdown).toContain("请介绍你的项目");
    expect(markdown).toContain("- 回答来源模式：project_qa_direct");
    expect(markdown).toContain("- Claim Gate：allow");
    expect(markdown.indexOf("请介绍你的项目")).toBeLessThan(markdown.indexOf("我负责了驱动和调试。"));
  });

  it("keeps canceled answers visible and handles empty conversations", () => {
    const emptySnapshot: InterviewSnapshot = {
      interview: { id: "interview-2", profileId: "profile-1", startedAt: 1_000, endedAt: 3_000, status: "error", language: "zh-CN", automationMode: "MANUAL", createdAt: 1_000 },
      transcripts: [],
      questions: [],
      answers: []
    };
    const emptyMarkdown = formatInterviewMarkdown(emptySnapshot, analyzeInterview(emptySnapshot));
    expect(emptyMarkdown).toContain("这场面试没有可导出的对话内容。");

    const canceledSnapshot: InterviewSnapshot = {
      ...emptySnapshot,
      interview: { ...emptySnapshot.interview, id: "interview-3" },
      answers: [{ id: "answer-2", questionId: "missing-question", text: "", model: "test-model", cancelReason: "timeout", createdAt: 2_000 }]
    };
    const markdown = formatInterviewMarkdown(canceledSnapshot, analyzeInterview(canceledSnapshot));

    expect(markdown).toContain("未完成 · 超时中断");
    expect(markdown).toContain("未生成完整回答");
  });

  it("renders a running record with a NULL end time without epoch leakage", () => {
    const startedAt = Date.now();
    const snapshot: InterviewSnapshot = {
      interview: { id: "interview-running", profileId: "profile-1", startedAt, endedAt: null as unknown as undefined, status: "running", language: "zh-CN", automationMode: "AUTO", createdAt: startedAt },
      transcripts: [],
      questions: [],
      answers: []
    };
    const markdown = formatInterviewMarkdown(snapshot, analyzeInterview(snapshot));
    expect(markdown).toContain("- 结束时间：—");
    expect(markdown).not.toContain("1970");
  });
});
