import { parentPort } from "node:worker_threads";
import { buildDeterministicProfile, ResumeAnalyzer, type ProfileBuilderInput, type ResumeDocument } from "@interview-copilot/shared";

if (!parentPort) throw new Error("Profile analysis worker requires parentPort");

parentPort.on("message", (message: { kind: "resume" | "profile"; payload: ResumeDocument | ProfileBuilderInput }) => {
  try {
    if (message.kind === "resume") {
      parentPort?.postMessage({ type: "progress", phase: "PARSING", progress: 0.2 });
      parentPort?.postMessage({ type: "progress", phase: "SECTION_DETECTION", progress: 0.55 });
      const result = new ResumeAnalyzer().analyze(message.payload as ResumeDocument);
      parentPort?.postMessage({ type: "progress", phase: "PROJECT_EXTRACTION", progress: 0.9 });
      parentPort?.postMessage({ type: "result", result });
      return;
    }
    parentPort?.postMessage({ type: "progress", phase: "PARSING", progress: 0.15 });
    parentPort?.postMessage({ type: "progress", phase: "SKILL_EXTRACTION", progress: 0.5 });
    const result = buildDeterministicProfile(message.payload as ProfileBuilderInput);
    parentPort?.postMessage({ type: "progress", phase: "VALIDATING", progress: 0.9 });
    parentPort?.postMessage({ type: "result", result });
  } catch (error) {
    parentPort?.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
});
