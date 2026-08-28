import type { ProjectSourceRole, RepositoryManifest } from "./types";

export type ProjectMaterialSourceRole = ProjectSourceRole | "auto";

export interface ProjectMaterialImportFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sourceRole?: ProjectMaterialSourceRole;
}

export interface ProjectMaterialImportItem {
  documentId?: string;
  filename: string;
  sourceRole: ProjectSourceRole;
  status: "ready" | "failed";
  assignmentStatus: "assigned" | "needs_assignment" | "failed";
  error?: string;
  duplicate?: boolean;
}

export type ProjectAnalysisJobStatus = "queued" | "mapping" | "exploring" | "synthesizing" | "grounding" | "completed" | "failed" | "cancelled";
export type ProjectAnalysisJobStage = Exclude<ProjectAnalysisJobStatus, "completed" | "failed" | "cancelled">;

export interface ProjectAnalysisJob {
  id: string;
  profileId: string;
  projectId: string;
  status: ProjectAnalysisJobStatus;
  stage: ProjectAnalysisJobStage | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  progress: number;
  filesTotal: number;
  filesExplored: number;
  toolCalls: number;
  modelTurns: number;
  errorCode?: string;
  errorMessage?: string;
  cancelRequested: boolean;
}

export interface ProjectMaterialImportReport {
  projectId: string;
  imported: ProjectMaterialImportItem[];
  rebuild: {
    status: "completed" | "failed" | "queued" | "skipped";
    analysisRunId?: string;
    analysisJobId?: string;
    error?: string;
  };
  repository?: Pick<RepositoryManifest, "archiveName" | "archiveSha256" | "fileCount" | "eligibleFileCount" | "skippedFileCount" | "totalSourceBytes" | "languages" | "directories" | "configFiles" | "testFiles" | "documentFiles"> & { documentId: string; duplicate?: boolean };
  analysisJob?: ProjectAnalysisJob;
  summary: {
    files: number;
    assigned: number;
    failed: number;
  };
}
