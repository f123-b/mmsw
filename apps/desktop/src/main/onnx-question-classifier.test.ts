import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OnnxQuestionClassifier } from "./onnx-question-classifier";

function artifactPath(fileName: string): string {
  const candidates = [
    resolve(process.cwd(), "models", "question-classifier", fileName),
    resolve(process.cwd(), "apps", "desktop", "models", "question-classifier", fileName)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Question classifier artifact is missing: ${fileName}`);
  return path;
}

describe("OnnxQuestionClassifier", () => {
  it("classifies realistic questions, contextual follow-ups, statements and fillers", async () => {
    const classifier = await OnnxQuestionClassifier.load(artifactPath("model.onnx"), artifactPath("labels.json"));
    await expect(classifier.predict("你这个项目为什么使用 CAN？")).resolves.toMatchObject({ type: "QUESTION" });
    await expect(classifier.predict("那为什么不用 UART？", ["面试官：你这个项目为什么使用 CAN？", "候选人：现场有多个节点，需要仲裁和抗干扰能力。"])) .resolves.toMatchObject({ type: "FOLLOW_UP" });
    await expect(classifier.predict("CAN 主要用于工业现场通信。")).resolves.toMatchObject({ type: "STATEMENT" });
    await expect(classifier.predict("嗯")).resolves.toMatchObject({ type: "OTHER" });
  });
});
