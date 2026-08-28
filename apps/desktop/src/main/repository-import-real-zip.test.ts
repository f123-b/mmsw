import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceProjectExplorer } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectAnalysisJobRepository, SqliteProjectMemoryRepository } from "./database";
import { ProjectMemoryService } from "./project-memory";

const archivePath = process.env.INTERVIEW_COPILOT_REAL_REPOSITORY_ZIP;
const realArchiveSuite = archivePath && existsSync(archivePath) ? describe : describe.skip;

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function waitForTerminalJob(service: ProjectMemoryService, projectId: string): Promise<NonNullable<ReturnType<ProjectMemoryService["getProjectAnalysisJob"]>>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = service.getProjectAnalysisJob(projectId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("real repository analysis did not finish in test timeout");
}

realArchiveSuite("Real repository ZIP import E2E", () => {
  it("imports, persists, explores, analyzes, and reloads a real GitHub-style archive without blocking the event loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "mmsw-real-repository-"));
    const databasePath = join(root, "knowledge.sqlite");
    let database: SqliteDatabase | undefined;
    let service: ProjectMemoryService | undefined;
    let projectId: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      database = await SqliteDatabase.open(databasePath);
      const profiles = new SqliteProfileRepository(database);
      const knowledge = new SqliteKnowledgeRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const analyses = new SqliteKnowledgeAnalysisRepository(database);
      const jobs = new SqliteProjectAnalysisJobRepository(database);
      const base = knowledge.createKnowledgeBase("真实仓库 E2E");
      const profile = profiles.save({ name: "真实仓库 E2E", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const project = memories.createProject(profile.id, "真实 GitHub 仓库");
      projectId = project.id;
      const trace: Array<{ event: string; fields: Record<string, unknown> }> = [];
      service = new ProjectMemoryService(
        profiles,
        knowledge,
        new SqliteInterviewHistoryRepository(database),
        memories,
        undefined,
        undefined,
        analyses,
        undefined,
        (event, fields) => trace.push({ event, fields }),
        undefined,
        true,
        jobs
      );

      const heartbeatDelays: number[] = [];
      let previousHeartbeat = performance.now();
      heartbeat = setInterval(() => {
        const now = performance.now();
        heartbeatDelays.push(now - previousHeartbeat);
        previousHeartbeat = now;
      }, 20);
      const startedAt = performance.now();
      const report = await service.importProjectMaterials({
        profileId: profile.id,
        projectId: project.id,
        knowledgeBaseId: base.id,
        files: [{ filename: archivePath!.split(/[\\/]/).at(-1) ?? "repository.zip", mimeType: "application/zip", bytes: readFileSync(archivePath!) }]
      });
      const importReturnMs = performance.now() - startedAt;

      expect(report.rebuild.status).toBe("queued");
      expect(report.repository?.eligibleFileCount).toBeGreaterThan(20);
      expect(report.repository?.fileCount).toBeGreaterThan(20);
      expect(report.analysisJob?.id).toBeTruthy();
      expect(importReturnMs).toBeLessThan(30_000);

      const imported = report.imported[0];
      expect(imported?.documentId).toBeTruthy();
      expect(trace.some((item) => item.event === "PROJECT_ARCHIVE_PROGRESS")).toBe(true);
      expect(trace.some((item) => item.event === "PROJECT_REPOSITORY_PERSISTED")).toBe(true);

      const job = await waitForTerminalJob(service, project.id);
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      const eventLoopP95Ms = percentile(heartbeatDelays, 0.95);
      console.log("PROJECT_REPOSITORY_REAL_E2E", JSON.stringify({ archivePath, archiveBytes: readFileSync(archivePath!).byteLength, importReturnMs: Math.round(importReturnMs), eventLoopP95Ms: Math.round(eventLoopP95Ms), eventLoopP95Under100ms: eventLoopP95Ms <= 100, traceEvents: trace.length }));
      expect(eventLoopP95Ms).toBeLessThan(100);
      expect(job.status, job.errorMessage).toBe("completed");
      const understanding = memories.getUnderstandingSnapshot(project.id)?.understanding;
      expect(understanding?.status).toBe("completed");
      expect(understanding?.trace.filesRead).toBeGreaterThan(0);
      expect(understanding?.semanticGraph?.nodes.length).toBeGreaterThan(0);
      expect(understanding?.evidenceRefs.length).toBeGreaterThan(0);
      expect(memories.listProjectSources(project.id).some((item) => item.sourceType === "repository")).toBe(true);

      const document = knowledge.getDocument(imported!.documentId!);
      expect(document?.text.length).toBeLessThan(20_000);
      expect(document?.repositoryFiles?.length).toBeGreaterThan(20);
      expect(document?.repositoryManifest?.archiveSha256).toBe(report.repository?.archiveSha256);
      expect(document?.repositoryFiles?.every((file) => !file.path.startsWith("lv_port_linux_frame_buffer-main/"))).toBe(true);
      expect(document?.repositoryFiles?.some((file) => /README\.md$/i.test(file.path))).toBe(true);
      const source = {
        id: document!.id,
        kind: "repository" as const,
        sourceType: "repository" as const,
        sourceRole: "code" as const,
        title: document!.filename,
        text: document!.text,
        repositoryFiles: document!.repositoryFiles,
        repositoryManifest: document!.repositoryManifest,
        repositorySkippedFiles: document!.repositorySkippedFiles,
        updatedAt: document!.updatedAt
      };
      const explorer = new SourceProjectExplorer([source]);
      const tree = explorer.listTree({ limit: 500 });
      expect(tree.length).toBeGreaterThan(20);
      const firstFile = explorer.readFile(tree[0]!.path);
      expect(firstFile?.text.length).toBeGreaterThan(0);
      expect(explorer.inspectBuildConfig().length).toBeGreaterThan(0);

      database.close();
      database = undefined;
      const reopened = await SqliteDatabase.open(databasePath);
      try {
        const reloadedKnowledge = new SqliteKnowledgeRepository(reopened);
        const reloadedJobs = new SqliteProjectAnalysisJobRepository(reopened);
        const reloaded = reloadedKnowledge.getDocument(document!.id);
        expect(reloaded?.repositoryFiles?.length).toBe(document!.repositoryFiles?.length);
        const reloadedFirstText = reloaded?.repositoryFiles?.find((file) => file.path === tree[0]!.path)?.text;
        expect(reloadedFirstText?.startsWith(firstFile?.text ?? "")).toBe(true);
        expect(reloadedJobs.latestForProject(project.id)?.status).toBe("completed");
      } finally {
        reopened.close();
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (service && projectId) {
        service.cancelAllAnalysisJobs();
        await waitForTerminalJob(service, projectId).catch(() => undefined);
      }
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
