import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileAnalysisJobManager, type ProfileAnalysisJob } from "./profile-analysis-job";

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

describe("ProfileAnalysisJobManager", () => {
  it("keeps the main-process heartbeat responsive while a worker analyzes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mmsw-profile-analysis-worker-"));
    const workerPath = join(root, "heartbeat-worker.mjs");
    await writeFile(workerPath, `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  parentPort.postMessage({ type: "progress", phase: "PARSING", progress: 0.25 });
  const end = Date.now() + 180;
  while (Date.now() < end) {}
  parentPort.postMessage({ type: "result", result: { ok: true } });
});\n`, "utf8");

    const heartbeatDelays: number[] = [];
    let previousHeartbeat = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      heartbeatDelays.push(now - previousHeartbeat);
      previousHeartbeat = now;
    }, 20);
    try {
      let resolveCompleted: (job: ProfileAnalysisJob) => void = () => undefined;
      const completed = new Promise<ProfileAnalysisJob>((resolve) => { resolveCompleted = resolve; });
      const manager = new ProfileAnalysisJobManager((job) => { if (job.status === "completed") resolveCompleted(job); }, workerPath);
      const job = manager.start("profile-1", "profile", { profileId: "profile-1" }, async () => undefined);
      expect(["queued", "running"]).toContain(job.status);
      const result = await completed;
      expect(result.phase).toBe("COMPLETED");
      expect(result.progress).toBe(1);
    } finally {
      clearInterval(heartbeat);
      await rm(root, { recursive: true, force: true });
    }
    const eventLoopP95Ms = percentile(heartbeatDelays, 0.95);
    expect(eventLoopP95Ms).toBeLessThan(100);
  }, 10_000);
});
