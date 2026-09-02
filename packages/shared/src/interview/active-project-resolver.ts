import { ProjectAliasResolver, type ProjectAliasCandidate } from "../project-alias-resolver";
import { copyActiveProject, copyProjectContextState, type ActiveProjectSource, type ActiveProjectState, type ProjectContextState } from "./project-context-state";

export interface ActiveProjectResolverInput {
  text: string;
  speaker?: "interviewer" | "candidate";
  projects?: readonly ProjectAliasCandidate[];
  explicitProjectId?: string;
  now?: number;
  entities?: readonly string[];
  topics?: readonly string[];
}

export type ProjectEvidenceLevel = "strong" | "medium" | "weak";

export interface ActiveProjectResolution {
  changed: boolean;
  status: ProjectContextState["status"];
  reason: string;
  activeProject?: ActiveProjectState;
  candidates: string[];
  evidenceLevel: ProjectEvidenceLevel;
}

const EXPLICIT_PROJECT_CUE = /(?:介绍|说说|聊聊|看你|这个|基于|做的|开发的|项目|系统|模块|经历|简历|里面|中)/iu;
const PROJECT_SWITCH_CUE = /(?:下面|接下来|然后|再看|换到|另一个|另一个项目|下一个项目|看你.*(?:下面|另一个))/iu;
const GENERIC_ASR_CONFLICT = /^(?:电梯|轿厢|导轨|舒适度)$/iu;

function copy(value: ActiveProjectResolution): ActiveProjectResolution {
  return { ...value, ...(value.activeProject ? { activeProject: copyActiveProject(value.activeProject) } : {}), candidates: [...value.candidates] };
}

/** Keeps project identity sticky; a single weak ASR token cannot switch it. */
export class ActiveProjectResolver {
  private stateValue: ProjectContextState = { status: "UNRESOLVED", candidates: [], updatedAt: 0 };
  private readonly aliases: ProjectAliasResolver;
  private pendingSwitch?: { projectId: string; count: number; level: ProjectEvidenceLevel; lastAt: number };

  constructor(aliasResolver = new ProjectAliasResolver()) { this.aliases = aliasResolver; }

  get state(): ProjectContextState { return copyProjectContextState(this.stateValue); }

  reset(now = 0): void { this.pendingSwitch = undefined; this.stateValue = { status: "UNRESOLVED", lockState: "UNRESOLVED", candidates: [], updatedAt: now }; }

  setManual(project: Pick<ActiveProjectState, "projectId" | "projectName"> & Partial<Pick<ActiveProjectState, "entities" | "topics">>, now = Date.now()): ActiveProjectResolution {
    this.pendingSwitch = undefined;
    this.stateValue = { status: "ACTIVE", lockState: "LOCKED", activeProject: { projectId: project.projectId, projectName: project.projectName, confidence: 1, source: "manual", activatedAt: now, entities: [...(project.entities ?? [])], topics: [...(project.topics ?? [])] }, candidates: project.projectId ? [project.projectId] : [], updatedAt: now, lastReason: "manual-selection" };
    return { changed: true, status: "ACTIVE", reason: "manual-selection", activeProject: copyActiveProject(this.stateValue.activeProject), candidates: [...this.stateValue.candidates], evidenceLevel: "strong" };
  }

  observe(input: ActiveProjectResolverInput): ActiveProjectResolution {
    const now = input.now ?? Date.now();
    const text = input.text.trim();
    const projects = input.projects ?? [];
    const explicit = input.explicitProjectId ? projects.find((project) => project.id === input.explicitProjectId) : undefined;
    const resolution = explicit
      ? { projectId: explicit.id, projectName: explicit.name, confidence: 1, ambiguous: false, reason: "exact-id" as const, candidates: [explicit.id] }
      : this.aliases.resolve(text, projects);
    const explicitCue = Boolean(input.explicitProjectId || PROJECT_SWITCH_CUE.test(text) || EXPLICIT_PROJECT_CUE.test(text) && (input.speaker === "candidate" || /(?:你这个|你们的|哪个项目|什么项目)/iu.test(text)));
    const evidenceLevel: ProjectEvidenceLevel = input.explicitProjectId || explicitCue || resolution.reason === "exact-id" || resolution.confidence >= 0.98 ? "strong" : resolution.confidence >= 0.78 ? "medium" : "weak";
    if (resolution.ambiguous) {
      this.stateValue = { ...this.stateValue, status: "AMBIGUOUS", lockState: "CONFLICT", candidates: [...resolution.candidates], updatedAt: now, lastReason: "ambiguous-project-reference" };
      return copy({ changed: false, status: "AMBIGUOUS", reason: "ambiguous-project-reference", activeProject: this.stateValue.activeProject, candidates: resolution.candidates, evidenceLevel: "weak" });
    }
    const resolvedProjectId = resolution.projectId;
    if (!resolvedProjectId) {
      const conflict = Boolean(this.stateValue.activeProject && GENERIC_ASR_CONFLICT.test(text) && this.stateValue.activeProject.entities.some((entity) => /FOC|电机|机器人|关节/i.test(entity)));
      this.stateValue = { ...this.stateValue, status: conflict ? "CONFLICT" : this.stateValue.activeProject ? "ACTIVE" : "UNRESOLVED", lockState: conflict ? "CONFLICT" : this.stateValue.activeProject ? this.stateValue.lockState ?? "LOCKED" : "UNRESOLVED", updatedAt: now, lastReason: conflict ? "single-asr-entity-conflict" : "no-project-evidence" };
      return copy({ changed: false, status: this.stateValue.status, reason: this.stateValue.lastReason ?? "no-project-evidence", activeProject: this.stateValue.activeProject, candidates: [...this.stateValue.candidates], evidenceLevel: "weak" });
    }
    const isSame = this.stateValue.activeProject?.projectId === resolvedProjectId;
    if (isSame || !this.stateValue.activeProject) this.pendingSwitch = undefined;
    const requiredEvidence = evidenceLevel === "strong" ? 1 : evidenceLevel === "medium" ? 2 : 3;
    if (!isSame && this.stateValue.activeProject && !explicitCue && resolution.confidence < 0.98) {
      const pending = this.pendingSwitch?.projectId === resolvedProjectId
        ? this.pendingSwitch
        : { projectId: resolvedProjectId, count: 0, level: evidenceLevel, lastAt: now };
      this.pendingSwitch = { ...pending, count: pending.count + 1, level: evidenceLevel, lastAt: now };
    }
    const maySwitch = !this.stateValue.activeProject || isSame || explicitCue || resolution.confidence >= 0.98 || (this.pendingSwitch?.projectId === resolvedProjectId && this.pendingSwitch.count >= requiredEvidence);
    if (!maySwitch) {
      this.stateValue = { ...this.stateValue, status: "ACTIVE", lockState: "SWITCH_PENDING", candidates: [resolvedProjectId], updatedAt: now, lastReason: "project-switch-candidate" };
      return copy({ changed: false, status: "ACTIVE", reason: "project-switch-candidate", activeProject: this.stateValue.activeProject, candidates: [resolvedProjectId], evidenceLevel });
    }
    const source: ActiveProjectSource = input.explicitProjectId || input.speaker === "candidate" ? "explicit_candidate" : explicitCue ? "explicit_interviewer" : isSame ? this.stateValue.activeProject?.source ?? "context_inheritance" : "resume_match";
    const activeProject: ActiveProjectState = {
      projectId: resolvedProjectId,
      projectName: resolution.projectName ?? resolvedProjectId,
      confidence: Math.max(0, Math.min(1, resolution.confidence)),
      source,
      activatedAt: isSame ? this.stateValue.activeProject?.activatedAt ?? now : now,
      entities: [...new Set([...(this.stateValue.activeProject?.projectId === resolvedProjectId ? this.stateValue.activeProject.entities : []), ...(input.entities ?? [])])],
      topics: [...new Set([...(this.stateValue.activeProject?.projectId === resolvedProjectId ? this.stateValue.activeProject.topics : []), ...(input.topics ?? [])])]
    };
    const reason = isSame ? "project-context-inherited" : "explicit-project-activation";
    const previousLock = this.stateValue.lockState;
    const lockState = isSame && previousLock === "LOCKED" || explicitCue || resolution.confidence >= 0.98 ? "LOCKED" : "CANDIDATE";
    this.stateValue = { status: "ACTIVE", lockState, activeProject, candidates: [resolvedProjectId], updatedAt: now, lastReason: reason };
    this.pendingSwitch = undefined;
    return copy({ changed: !isSame, status: "ACTIVE", reason, activeProject, candidates: [resolvedProjectId], evidenceLevel });
  }
}
