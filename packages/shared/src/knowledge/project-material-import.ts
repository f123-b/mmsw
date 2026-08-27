import type { ProjectSourceRole } from "./types";

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
}

export interface ProjectMaterialImportReport {
  projectId: string;
  imported: ProjectMaterialImportItem[];
  rebuild: {
    status: "completed" | "failed" | "skipped";
    analysisRunId?: string;
    error?: string;
  };
  summary: {
    files: number;
    assigned: number;
    failed: number;
  };
}
