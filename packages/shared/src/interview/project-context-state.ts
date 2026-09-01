export type ActiveProjectSource = "explicit_interviewer" | "explicit_candidate" | "resume_match" | "context_inheritance" | "manual";
export type ProjectContextStatus = "UNRESOLVED" | "ACTIVE" | "AMBIGUOUS" | "CONFLICT";

export interface ActiveProjectState {
  projectId?: string;
  projectName?: string;
  confidence: number;
  source: ActiveProjectSource;
  activatedAt: number;
  entities: string[];
  topics: string[];
}

export interface ProjectContextState {
  status: ProjectContextStatus;
  activeProject?: ActiveProjectState;
  candidates: string[];
  lastReason?: string;
  updatedAt: number;
}

export function copyActiveProject(value?: ActiveProjectState): ActiveProjectState | undefined {
  return value ? { ...value, entities: [...value.entities], topics: [...value.topics] } : undefined;
}

export function copyProjectContextState(value: ProjectContextState): ProjectContextState {
  return { ...value, ...(value.activeProject ? { activeProject: copyActiveProject(value.activeProject) } : {}), candidates: [...value.candidates] };
}
