import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";
import type { LocalQuestionLabel, LocalQuestionModel, LocalQuestionResult } from "@interview-copilot/shared";

const LABELS = new Set<LocalQuestionLabel>(["QUESTION", "FOLLOW_UP", "STATEMENT", "OTHER"]);

function composeInput(text: string, context: string[]): string {
  const normalizedContext = context.filter(Boolean);
  if (!normalizedContext.length) return `当前面试发言：${text}`;
  return `上一轮面试对话：${normalizedContext.join(" | ")} 当前面试发言：${text}`;
}

function asLabel(value: unknown): LocalQuestionLabel | undefined {
  const label = String(value);
  return LABELS.has(label as LocalQuestionLabel) ? label as LocalQuestionLabel : undefined;
}

/**
 * Node/Electron adapter for the local ONNX speech-act model. The shared layer
 * only sees LocalQuestionModel, so a future MiniLM/DistilBERT export can use
 * the same boundary without leaking ONNX into packages/shared.
 */
export class OnnxQuestionClassifier implements LocalQuestionModel {
  private constructor(private readonly session: ort.InferenceSession, private readonly labels: LocalQuestionLabel[]) {}

  static async load(modelPath: string, labelsPath: string): Promise<OnnxQuestionClassifier> {
    const labelsJson = JSON.parse(await readFile(labelsPath, "utf8")) as unknown;
    if (!Array.isArray(labelsJson) || labelsJson.length < 2) throw new Error("Question classifier labels are invalid");
    const labels = labelsJson.map(asLabel);
    if (labels.some((label) => !label)) throw new Error("Question classifier contains an unsupported label");
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
    return new OnnxQuestionClassifier(session, labels as LocalQuestionLabel[]);
  }

  async predict(text: string, context: string[] = []): Promise<LocalQuestionResult> {
    const inputName = this.session.inputNames[0];
    if (!inputName) throw new Error("Question classifier has no input");
    const input = new ort.Tensor("string", [composeInput(text, context)], [1]);
    const output = await this.session.run({ [inputName]: input });
    const tensors = Object.values(output);
    const probabilityTensor = tensors.find((tensor) => tensor.dims.length === 2 && tensor.dims[0] === 1 && tensor.dims[1] === this.labels.length);
    if (!probabilityTensor) throw new Error("Question classifier probability output is missing");
    const probabilities = Array.from(probabilityTensor.data as Float32Array | number[]).map(Number);
    let bestIndex = 0;
    for (let index = 1; index < probabilities.length; index += 1) if (probabilities[index] > probabilities[bestIndex]) bestIndex = index;
    const labelTensor = tensors.find((tensor) => tensor.type === "string");
    const label = labelTensor ? asLabel(Array.from(labelTensor.data as string[])[0]) : undefined;
    return {
      type: label ?? this.labels[bestIndex],
      confidence: Math.max(0, Math.min(1, probabilities[bestIndex] ?? 0))
    };
  }
}

export function composeQuestionClassifierInput(text: string, context: string[] = []): string {
  return composeInput(text, context);
}
