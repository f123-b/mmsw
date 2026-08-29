import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { join } from "node:path";

export type ProfileAnalysisPhase = "QUEUED" | "PARSING" | "SECTION_DETECTION" | "PROJECT_EXTRACTION" | "SKILL_EXTRACTION" | "MODEL_ANALYSIS" | "VALIDATING" | "SAVING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ProfileAnalysisJobKind = "resume" | "profile";

export interface ProfileAnalysisJob {
  id: string;
  profileId: string;
  kind: ProfileAnalysisJobKind;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: ProfileAnalysisPhase;
  progress: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

interface WorkerProgress { type: "progress"; phase: ProfileAnalysisPhase; progress: number; }
interface WorkerResult { type: "result"; result: unknown; }
interface WorkerFailure { type: "error"; error: string; }

type JobListener = (job: ProfileAnalysisJob) => void;
type ResultHandler = (result: unknown, job: ProfileAnalysisJob) => void | Promise<void>;

export class ProfileAnalysisJobManager {
  private readonly jobs = new Map<string, ProfileAnalysisJob>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly onUpdate?: JobListener, private readonly workerPath = join(__dirname, "profile-analysis-worker.js")) {}

  get(jobId: string): ProfileAnalysisJob | undefined { const job = this.jobs.get(jobId); return job ? { ...job } : undefined; }
  list(profileId: string, kind?: ProfileAnalysisJobKind): ProfileAnalysisJob[] { return [...this.jobs.values()].filter((job) => job.profileId === profileId && (!kind || job.kind === kind)).sort((left, right) => right.updatedAt - left.updatedAt).map((job) => ({ ...job })); }

  start(profileId: string, kind: ProfileAnalysisJobKind, payload: unknown, onResult: ResultHandler): ProfileAnalysisJob {
    const existing = [...this.jobs.values()].find((job) => job.profileId === profileId && job.kind === kind && ["queued", "running"].includes(job.status));
    if (existing) return { ...existing };
    const now = Date.now();
    const job: ProfileAnalysisJob = { id: `profile-analysis-${randomUUID()}`, profileId, kind, status: "queued", phase: "QUEUED", progress: 0, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.emit(job);
    let worker: Worker;
    try {
      worker = new Worker(this.workerPath);
    } catch (error) {
      this.fail(job.id, String(error));
      return { ...job, status: "failed", phase: "FAILED", error: String(error), updatedAt: Date.now() };
    }
    this.workers.set(job.id, worker);
    worker.on("message", (message: WorkerProgress | WorkerResult | WorkerFailure) => {
      if (message.type === "progress") {
        const current = this.jobs.get(job.id);
        if (!current || current.status === "cancelled") return;
        current.status = "running";
        current.phase = message.phase;
        current.progress = Math.max(0, Math.min(1, message.progress));
        current.updatedAt = Date.now();
        this.emit(current);
      } else if (message.type === "result") {
        const current = this.jobs.get(job.id);
        if (!current || current.status === "cancelled") return;
        current.status = "running";
        current.phase = "VALIDATING";
        current.progress = Math.max(current.progress, 0.9);
        current.updatedAt = Date.now();
        this.emit(current);
        void Promise.resolve(onResult(message.result, { ...current })).then(() => {
          const completed = this.jobs.get(job.id);
          if (!completed || completed.status === "cancelled") return;
          completed.status = "completed";
          completed.phase = "COMPLETED";
          completed.progress = 1;
          completed.updatedAt = Date.now();
          this.emit(completed);
          void worker.terminate();
          this.workers.delete(job.id);
        }).catch((error) => { this.fail(job.id, String(error)); void worker.terminate(); this.workers.delete(job.id); });
      } else this.fail(job.id, message.error);
    });
    worker.once("error", (error) => { this.fail(job.id, String(error)); this.workers.delete(job.id); });
    worker.once("exit", (code) => { if (code !== 0 && this.jobs.get(job.id)?.status === "running") this.fail(job.id, `Profile analysis worker exited with code ${code}`); });
    worker.postMessage({ jobId: job.id, kind, payload });
    return { ...job, status: "running", phase: "PARSING", progress: 0.05, updatedAt: Date.now() };
  }

  cancel(jobId: string): ProfileAnalysisJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return job ? { ...job } : undefined;
    job.status = "cancelled";
    job.phase = "CANCELLED";
    job.updatedAt = Date.now();
    this.emit(job);
    void this.workers.get(jobId)?.terminate();
    this.workers.delete(jobId);
    return { ...job };
  }

  private fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "cancelled") return;
    job.status = "failed";
    job.phase = "FAILED";
    job.error = error.slice(0, 500);
    job.updatedAt = Date.now();
    this.emit(job);
  }

  private emit(job: ProfileAnalysisJob): void { this.onUpdate?.({ ...job }); }
}
