import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerAgent, ModelRouter, type AnswerProvider, type AnswerProviderRequest } from "@interview-copilot/shared";
import { WrittenTestController } from "./written-test-controller";
import { openAppDatabase, type SqliteDatabase } from "./database";
import { SqliteWrittenTestHistoryRepository } from "./written-test-history-repository";

function result(rawText = "计算 1 + 1", type = "CALCULATION") {
  return { inputStatus: "COMPLETE", missingInformation: [] as string[], problem: { rawText, canonicalQuestion: rawText, questionType: type, requirements: ["给出结果"], inputs: [], outputs: [], constraints: ["使用整数"], formulas: [], requestedArtifacts: { formula: type === "CALCULATION", code: type === "PROGRAMMING" }, confidence: 0.95 }, answer: { questionType: type, finalAnswer: "2", steps: [], equations: ["1 + 1 = 2"], explanation: "", warnings: [], confidence: 0.9 } };
}

describe("WrittenTestController persisted structured pipeline", () => {
  let root: string; let database: SqliteDatabase; let repository: SqliteWrittenTestHistoryRepository;
  let controller: WrittenTestController; let requests: AnswerProviderRequest[]; let replies: Array<string | Error>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "written-controller-")); database = await openAppDatabase(root); repository = new SqliteWrittenTestHistoryRepository(database);
    requests = []; replies = [];
    const provider: AnswerProvider = { stream: async function* (request) {
      requests.push(request); const reply = replies.shift() ?? JSON.stringify(result());
      if (reply instanceof Error) throw reply;
      // Split inside arbitrary JSON/code characters, as a real stream does.
      for (let index = 0; index < reply.length; index += 7) yield reply.slice(index, index + 7);
    } };
    controller = new WrittenTestController({ repository, answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "vision-test" })), contextProvider: () => { throw new Error("Interview profile must not be requested"); } });
    controller.start({ profileId: "p-1", answerMode: "NORMAL" });
  });
  afterEach(async () => { controller.stop(); database.close(); await rm(root, { recursive: true, force: true }); vi.useRealTimers(); });
  const png = "data:image/png;base64,YWJj";
  async function capture(mime: "image/png" | "image/jpeg" = "image/png", signal?: AbortSignal) {
    const id = `image-${Math.random()}`; const dataUrl = `data:${mime};base64,YWJj`;
    return controller.answerScreenshot(dataUrl, { id, sessionId: controller.sessionId!, filePath: join(root, `${id}.png`), mimeType: mime, sha256: id, capturedAt: Date.now(), dataUrl }, signal);
  }
  it("publishes only validated complete output and preserves code escapes/Unicode", async () => {
    const code = 'const 名称 = "中文 Ω 😀";\nconsole.log("\\n", /\\d+/);';
    replies.push(JSON.stringify({ ...result("实现函数", "PROGRAMMING"), answer: { ...result().answer, questionType: "PROGRAMMING", code: { language: "javascript", content: code } } }));
    const events: string[] = []; controller.on("event", (event) => { if (event.type === "realtime_message") events.push(event.message.type); });
    await capture("image/jpeg");
    expect(controller.state.screenshotStatus).toBe("SUCCESS");
    expect(controller.state.currentAnswer?.code?.content).toBe(code);
    expect(repository.getSessionDetail(controller.sessionId!)?.questions[0]?.answer?.code?.content).toBe(code);
    expect(requests[0]?.attachments?.[0]?.mimeType).toBe("image/jpeg");
    expect(requests[0]?.sections.map((s) => s.name)).toEqual(["system/base", "question", "output-format"]);
    expect(events).toEqual(["answer_start", "answer_delta", "answer_end"]);
  });
  it("rejects malformed output after one repair and never saves it as an answer", async () => {
    replies.push("{broken json", "{broken json");
    await expect(capture()).rejects.toThrow("JSON 无效");
    expect(requests).toHaveLength(2); expect(controller.state.screenshotStatus).toBe("ERROR");
    expect(controller.state.currentAnswer).toBeUndefined();
    expect(repository.getSessionDetail(controller.sessionId!)?.questions).toHaveLength(0);
    await capture(); expect(controller.state.screenshotStatus).toBe("SUCCESS");
  });
  it("regenerates a damaged response instead of displaying replacement characters", async () => {
    const damaged = result(); damaged.answer.finalAnswer = "答\uFFFD";
    replies.push(JSON.stringify(damaged), JSON.stringify(result()));
    await capture(); expect(requests).toHaveLength(2); expect(controller.state.currentAnswer?.finalAnswer).toBe("2");
    expect(requests[1]?.sections.at(-1)?.content).toContain("含损坏字符");
  });
  it("holds incomplete questions for another image and includes both images and original constraints", async () => {
    const partial = result("给定一个整数数组，求…"); partial.inputStatus = "NEEDS_INPUT"; partial.missingInformation = ["缺少输出要求"]; partial.answer.finalAnswer = "";
    replies.push(JSON.stringify(partial)); await capture();
    expect(controller.state.screenshotStatus).toBe("NEEDS_INPUT"); expect(controller.state.currentAnswer).toBeUndefined();
    expect(repository.getSessionDetail(controller.sessionId!)?.questions[0]?.answer).toBeUndefined();
    const second = result("补充：求和"); second.problem.constraints = []; replies.push(JSON.stringify(second));
    await capture();
    expect(requests[1]?.attachments).toHaveLength(2);
    expect(requests[1]?.sections.find((s) => s.name === "question")?.content).toContain("使用整数");
    expect(controller.state.currentProblem?.constraints).toContain("使用整数");
    expect(controller.state.currentProblem?.rawText).toContain("给定一个整数数组");
    expect(controller.state.questionCount).toBe(1); expect(controller.state.screenshotCount).toBe(2);
  });
  it("defaults to a new question and supports replacement without merging old images", async () => {
    await capture(); await capture(); expect(controller.state.questionCount).toBe(2); expect(requests[1]?.attachments).toHaveLength(1);
    controller.setNextScreenshotRelation("REPLACE_SCREENSHOT"); await capture();
    expect(controller.state.questionCount).toBe(2); expect(requests[2]?.attachments).toHaveLength(1);
  });
  it("marks missing artifacts as REVIEW and never fabricates a diagram", async () => {
    const value = result("请画状态机", "STATE_MACHINE");
    Object.assign(value.problem.requestedArtifacts, { diagram: true });
    replies.push(JSON.stringify(value), JSON.stringify(value)); await capture();
    expect(controller.state.screenshotStatus).toBe("REVIEW"); expect(controller.state.currentAnswer?.diagram).toBeUndefined();
    expect(controller.state.currentAnswer?.warnings.join()).toContain("图示");
  });
  it("does not describe low confidence as success", async () => {
    const value = result(); value.answer.confidence = 0.3; replies.push(JSON.stringify(value)); await capture();
    expect(controller.state.screenshotStatus).toBe("REVIEW");
  });
  it("clears stale answers and releases capture failure for retry", async () => {
    await capture(); controller.markCapturing(); expect(controller.state.currentAnswer).toBeUndefined();
    controller.markCaptureFailed("未取得截图", controller.sessionId); expect(controller.state.screenshotStatus).toBe("ERROR");
    await capture(); expect(controller.state.screenshotStatus).toBe("SUCCESS");
  });
  it("propagates provider errors so the outer operation cannot claim success", async () => {
    replies.push(new Error("provider offline")); await expect(capture()).rejects.toThrow("provider offline");
    expect(controller.state.screenshotStatus).toBe("ERROR"); await capture(); expect(controller.state.screenshotStatus).toBe("SUCCESS");
  });
  it("settles cancellation even if a provider ignores abort and blocks late writes to a new session", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: AnswerProvider = { stream: async function* () { await gate; yield JSON.stringify(result()); } };
    controller.stop(); controller = new WrittenTestController({ repository, answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "test" })) });
    controller.start({ profileId: "p-1", answerMode: "NORMAL" });
    const signal = new AbortController(); const pending = capture("image/png", signal.signal); const rejection = expect(pending).rejects.toBeDefined();
    signal.abort(); await rejection;
    const oldSession = controller.sessionId!; controller.stop(); controller.start({ profileId: "p-1", answerMode: "NORMAL" });
    release(); await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repository.getSessionDetail(oldSession)?.questions).toHaveLength(0); expect(controller.state.screenshotStatus).toBe("IDLE");
    expect(controller.state.currentAnswer).toBeUndefined();
  });
  it("enforces an operation deadline and allows retry", async () => {
    vi.useFakeTimers();
    let call = 0;
    const provider: AnswerProvider = { stream: async function* () { if (call++ === 0) await new Promise<void>(() => {}); yield JSON.stringify(result()); } };
    controller.stop(); controller = new WrittenTestController({ repository, analysisTimeoutMs: 100, answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "test" })) });
    controller.start({ profileId: "p-1", answerMode: "NORMAL" });
    const pending = capture(); const rejection = expect(pending).rejects.toThrow("分析超时");
    await vi.advanceTimersByTimeAsync(101); await rejection; expect(controller.state.screenshotStatus).toBe("ERROR");
    await capture(); expect(controller.state.screenshotStatus).toBe("SUCCESS");
  });
  it("validates archive ownership and pre-aborted input without publishing", async () => {
    const signal = new AbortController(); signal.abort(); await expect(capture("image/png", signal.signal)).rejects.toBeDefined();
    await expect(controller.answerScreenshot(png)).rejects.toThrow("归档"); expect(requests).toHaveLength(0);
  });
});
