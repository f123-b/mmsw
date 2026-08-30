import type { RuntimeOperationMode } from "../shared/runtime-operation-mode";

type ScreenshotApi = {
  interview: { answerScreenshot: () => Promise<void> };
  writtenTest: { answerScreenshot: () => Promise<void> };
};

export function answerScreenshotForMode(mode: RuntimeOperationMode, api: ScreenshotApi = window.interviewCopilot): Promise<void> {
  return mode === "WRITTEN_TEST" ? api.writtenTest.answerScreenshot() : api.interview.answerScreenshot();
}
