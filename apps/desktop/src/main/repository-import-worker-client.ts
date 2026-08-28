import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ParsedDocument } from "@interview-copilot/shared";

export interface RepositoryImportProgress { entriesProcessed: number; entriesTotal: number; filesAccepted: number; expandedBytes: number; }

function workerPath(): string {
  const candidates = [
    process.env.INTERVIEW_COPILOT_REPOSITORY_WORKER_PATH,
    join(__dirname, "repository-import-worker.js"),
    join(process.cwd(), "out", "main", "repository-import-worker.js"),
    join(process.cwd(), "apps", "desktop", "out", "main", "repository-import-worker.js")
  ].filter((candidate): candidate is string => Boolean(candidate));
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (selected) return selected;
  throw new Error("REPOSITORY_IMPORT_WORKER_UNAVAILABLE");
}

export async function parseRepositoryArchiveInWorker(input: { documentId: string; filename: string; bytes: Uint8Array; onProgress?: (progress: RepositoryImportProgress) => void; signal?: AbortSignal }): Promise<ParsedDocument> {
  if (input.signal?.aborted) throw new Error("PROJECT_ANALYSIS_CANCELLED");
  const bytes = input.bytes.slice();
  return new Promise<ParsedDocument>((resolve, reject) => {
    const worker = new Worker(workerPath());
    let settled = false;
    const finish = (callback: () => void): void => { if (settled) return; settled = true; input.signal?.removeEventListener("abort", abort); void worker.terminate(); callback(); };
    const abort = (): void => finish(() => reject(new Error("PROJECT_ANALYSIS_CANCELLED")));
    input.signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { type?: string; progress?: RepositoryImportProgress; error?: string } & Partial<ParsedDocument>) => {
      if (message.type === "progress" && message.progress) { input.onProgress?.(message.progress); return; }
      if (message.type === "error") { finish(() => reject(new Error(message.error ?? "REPOSITORY_EXTRACTION_FAILED"))); return; }
      if (message.type === "result") finish(() => resolve(message as ParsedDocument));
    });
    worker.once("error", (error) => finish(() => reject(new Error(`REPOSITORY_EXTRACTION_FAILED: ${String(error)}`))));
    worker.once("exit", (code) => { if (code !== 0 && !settled) finish(() => reject(new Error(`REPOSITORY_EXTRACTION_FAILED: worker exited ${code}`))); });
    worker.postMessage({ type: "parse", documentId: input.documentId, filename: input.filename, bytes }, [bytes.buffer]);
  });
}
