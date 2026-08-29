import type { AnswerRecord, InterviewMetrics, InterviewSnapshot, QuestionRecord, TranscriptRecord } from "@interview-copilot/shared";

export interface InterviewExportResult {
  canceled: boolean;
  path?: string;
  bytes?: number;
}

function display(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function inline(value: unknown, fallback = "—"): string {
  return display(value, fallback).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

function dateTime(value?: number): string {
  return value === undefined ? "—" : new Date(value).toLocaleString("zh-CN");
}

function duration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分 ${seconds} 秒` : `${minutes} 分 ${seconds} 秒`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function blockquote(value: string): string {
  const text = display(value, "—");
  return text.split(/\r?\n/).map((line) => `> ${line || " "}`).join("\n");
}

function corrections(value?: Array<{ raw: string; canonical: string; source?: string; confidence?: number; reason?: string }>): string {
  if (!value?.length) return "—";
  return value.map((item) => `${inline(item.raw)} → ${inline(item.canonical)}${item.source ? `（${inline(item.source)}）` : ""}`).join("；");
}

function transcriptLabel(record: TranscriptRecord): string {
  return record.source === "remote" ? "面试官" : "我";
}

function questionStatus(status: QuestionRecord["status"]): string {
  const labels: Record<QuestionRecord["status"], string> = {
    candidate: "候选",
    confirmed: "已确认",
    answering: "回答中",
    superseded: "已替换",
    answered: "已回答",
    ignored: "已忽略"
  };
  return labels[status];
}

function answerStatus(answer: AnswerRecord): string {
  if (!answer.cancelReason) return "已生成";
  const labels: Record<NonNullable<AnswerRecord["cancelReason"]>, string> = {
    user: "手动停止",
    superseded: "被下一题替换",
    timeout: "超时中断"
  };
  return `未完成 · ${labels[answer.cancelReason]}`;
}

function telemetryLines(answer: AnswerRecord): string[] {
  const telemetry = answer.telemetry;
  if (!telemetry) return [];
  return [
    `- 原始问题：${inline(telemetry.rawText)}`,
    `- 规范化问题：${inline(telemetry.normalizedText)}`,
    `- 标准问题：${inline(telemetry.canonicalText)}`,
    `- 回答来源模式：${inline(telemetry.answerSourceMode)}`,
    `- 语义帧：${inline(telemetry.semanticFrame)}`,
    `- 上下文关系：${inline(telemetry.contextRelation ?? telemetry.topicRelation)}`,
    `- Claim Gate：${inline(telemetry.claimGateDecision)}`,
    `- Technical Guard：${inline(telemetry.technicalGuardDecision)}（违规 ${telemetry.technicalViolationCount ?? 0}）`,
    `- 术语修正：${telemetry.terminologyCorrectionCount ?? 0}（置信度 ${telemetry.terminologyConfidence?.toFixed(2) ?? "—"}）`,
    `- Core QA：${inline(telemetry.coreQaQuestionId)}`,
    `- Project QA：${inline(telemetry.projectQaQuestionId)}`,
    `- 历史 revision：${inline(telemetry.historyRevision)}`
  ];
}

export function formatInterviewMarkdown(snapshot: InterviewSnapshot, metrics: InterviewMetrics): string {
  const { interview } = snapshot;
  const questions = new Map(snapshot.questions.map((question) => [question.id, question]));
  const answers = new Map(snapshot.answers.map((answer) => [answer.questionId, answer]));
  const timeline = [
    ...snapshot.transcripts.filter((record) => record.text.trim()).map((record) => ({ at: record.createdAt, kind: "transcript" as const, record })),
    ...snapshot.answers.filter((record) => record.text.trim() || record.cancelReason).map((record) => ({ at: record.finishedAt ?? record.createdAt, kind: "answer" as const, record }))
  ].sort((left, right) => left.at - right.at);
  const lines: string[] = [
    "# 面试记录",
    "",
    "## 基本信息",
    "",
    `- 记录 ID：${inline(interview.id)}`,
    `- 面试档案：${inline(interview.profileId)}`,
    `- 项目：${inline(interview.projectId)}`,
    `- 目标岗位：${inline(interview.jobTargetId)}`,
    `- 开始时间：${dateTime(interview.startedAt)}`,
    `- 结束时间：${dateTime(interview.endedAt)}`,
    `- 状态：${inline(interview.status)}`,
    `- 语言：${inline(interview.language)}`,
    `- 自动回答：${inline(interview.automationMode)}`,
    "",
    "## 统计",
    "",
    `- 面试时长：${duration(metrics.durationMs)}`,
    `- 面试官转写：${metrics.remoteTranscriptCount} 条 / ${metrics.remoteWordCount} 词`,
    `- 我的转写：${metrics.micTranscriptCount} 条 / ${metrics.micWordCount} 词`,
    `- 识别问题：${metrics.questionCount} 个`,
    `- 已回答问题：${metrics.answeredQuestionCount} 个`,
    `- 回答率：${percent(metrics.answerRate)}`,
    `- 平均首 token：${metrics.averageFirstTokenMs === undefined ? "—" : `${Math.round(metrics.averageFirstTokenMs)} ms`}`,
    `- 平均回答耗时：${metrics.averageAnswerLatencyMs === undefined ? "—" : `${Math.round(metrics.averageAnswerLatencyMs)} ms`}`,
    "",
    "## 对话记录",
    ""
  ];

  if (timeline.length === 0) lines.push("这场面试没有可导出的对话内容。", "");
  timeline.forEach((entry) => {
    if (entry.kind === "transcript") {
      const record = entry.record;
      lines.push(`### ${transcriptLabel(record)} · ${dateTime(record.createdAt)}`, "", blockquote(record.text), "");
      if (record.rawText || record.normalizedText || record.canonicalText || record.terminologyCorrections?.length) {
        lines.push(
          "<details>",
          "<summary>转写诊断</summary>",
          "",
          `- 原始文本：${inline(record.rawText)}`,
          `- 规范化文本：${inline(record.normalizedText)}`,
          `- 标准文本：${inline(record.canonicalText)}`,
          `- 术语修正：${corrections(record.terminologyCorrections)}`,
          "",
          "</details>",
          ""
        );
      }
      return;
    }

    const record = entry.record;
    lines.push(`### AI 回答 · ${dateTime(record.finishedAt ?? record.createdAt)}`, "", `- 针对问题：${inline(questions.get(record.questionId)?.text, record.questionId)}`, `- 模型：${inline(record.model)}`, `- 模式：${inline(record.mode)}`, `- 状态：${answerStatus(record)}`, `- 首 token：${record.latencyFirstToken === undefined ? "—" : `${record.latencyFirstToken} ms`}`, `- 总耗时：${record.latencyTotal === undefined ? "—" : `${record.latencyTotal} ms`}`, "", blockquote(record.text || "未生成完整回答"), "");
  });

  if (snapshot.questions.length > 0) {
    lines.push("## 问题理解诊断", "");
    snapshot.questions.forEach((question, index) => {
      lines.push(
        `### ${index + 1}. ${inline(question.text)}`,
        "",
        `- 状态：${questionStatus(question.status)}`,
        `- 置信度：${inline(question.confidence)}`,
        `- 识别来源：${inline(question.source)}`,
        `- 检测时间：${dateTime(question.detectedAt)}`,
        `- 语义帧：${inline(question.semanticFrame)}`,
        `- 上下文关系：${inline(question.contextRelation)}`,
        `- 主题：${inline(question.topic ?? question.inheritedTopic)}`,
        `- 原始转写：${inline(question.rawTranscript)}`,
        `- 规范化问题：${inline(question.normalizedQuestion)}`,
        `- 标准问题：${inline(question.canonicalQuestion)}`,
        `- 术语修正：${corrections(question.terminologyCorrections)}`,
        ""
      );
    });
  }

  if (snapshot.answers.length > 0) {
    lines.push("## 回答诊断", "");
    snapshot.answers.forEach((answer, index) => {
      lines.push(`### ${index + 1}. ${inline(questions.get(answer.questionId)?.text, answer.questionId)}`, "", `- 状态：${answerStatus(answer)}`, `- 模型：${inline(answer.model)}`, `- 模式：${inline(answer.mode)}`, ...telemetryLines(answer), "");
    });
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
