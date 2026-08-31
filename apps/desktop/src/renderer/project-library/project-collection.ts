import type { ProjectMemoryProject } from "@interview-copilot/shared";

export interface ProjectCollectionRecord {
  id: string;
  name: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
  ownershipMode?: ProjectMemoryProject["ownershipMode"];
  ownershipNote?: string;
}

function placeholderProject(record: ProjectCollectionRecord): ProjectMemoryProject {
  return {
    id: record.id,
    profileId: record.profileId,
    name: record.name,
    description: "项目资料已创建，添加资料后生成项目摘要。",
    role: "",
    hardware: [],
    software: [],
    technologyStack: [],
    sourceIds: [],
    confidence: 0,
    ownershipMode: record.ownershipMode,
    ownershipNote: record.ownershipNote
  };
}

/**
 * The SQLite projects table is the collection source. Memory is only an
 * optional enrichment layer, so a project remains selectable before analysis
 * and after a failed/stale analysis run.
 */
export function mergeProjectCollection(records: ProjectCollectionRecord[], memoryProjects: ProjectMemoryProject[]): ProjectMemoryProject[] {
  const memoryById = new Map(memoryProjects.map((project) => [project.id, project]));
  const collection = records.length > 0
    ? records
    : memoryProjects.map((project) => ({ id: project.id, name: project.name, profileId: project.profileId, createdAt: 0, updatedAt: 0, ownershipMode: project.ownershipMode, ownershipNote: project.ownershipNote }));

  return collection.map((record) => ({
    ...placeholderProject(record),
    ...memoryById.get(record.id),
    id: record.id,
    name: record.name,
    ...(record.profileId ? { profileId: record.profileId } : {}),
    ...(record.ownershipMode ? { ownershipMode: record.ownershipMode } : {}),
    ...(record.ownershipNote ? { ownershipNote: record.ownershipNote } : {})
  }));
}

export function nextProjectIdAfterDelete(records: ProjectCollectionRecord[], deletedProjectId: string): string | undefined {
  return records.find((project) => project.id !== deletedProjectId)?.id;
}
