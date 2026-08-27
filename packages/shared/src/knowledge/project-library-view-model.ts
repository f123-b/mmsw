import { calculateProjectCompleteness, type ProjectCompletenessResult } from "./project-completeness";
import { listConflictGroups, listUserActions } from "./project-actions";
import { isFactEligible } from "./project-fact-eligibility";
import { deriveProjectView } from "./project-view";
import type {
  ProjectConflictGroup,
  ProjectFact,
  ProjectMemoryModule,
  ProjectMemoryProject,
  ProjectInterviewQuestion,
  ProjectProblem,
  ProjectTechnologyGroup
} from "./types";

export interface ProjectLibraryNextAction {
  type: "analyze_sources" | "missing_parameters" | "missing_decisions" | "conflict" | "missing_sources";
  title: string;
  description: string;
  priority: "high" | "medium";
}

export type ProjectAnalysisStatus = "empty" | "sources_ready" | "analyzing" | "ready" | "failed" | "stale";

export interface ProjectLibraryViewModel {
  project: ProjectMemoryProject;
  summary: string;
  technologies: ProjectTechnologyGroup[];
  parameters: ProjectFact[];
  decisions: ProjectFact[];
  problems: ProjectProblem[];
  modules: ProjectMemoryModule[];
  questions: ProjectInterviewQuestion[];
  results: ProjectFact[];
  limitations: ProjectFact[];
  conflicts: ProjectConflictGroup[];
  familiarity: {
    overall: number;
    technical: number;
    parameters: number;
    decisions: number;
    problems: number;
  };
  status: {
    trustedFacts: number;
    pendingActions: number;
    conflictGroups: number;
    staleFacts: number;
    sourceCount: number;
  };
  analysisStatus: ProjectAnalysisStatus;
  nextActions: ProjectLibraryNextAction[];
  completeness: ProjectCompletenessResult;
}

function isNotMeasured(fact: ProjectFact): boolean {
  return fact.evidenceLevel === "not-measured" || /未测量|未测试|没有正式 benchmark|无正式 benchmark/i.test(fact.content);
}

function byUpdatedAt(left: ProjectFact, right: ProjectFact): number {
  return (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0);
}

function uniqueFacts(facts: ProjectFact[]): ProjectFact[] {
  return facts.filter((fact, index, all) => all.findIndex((item) => item.id === fact.id) === index);
}

/**
 * A read-only presentation model for Project Library. It deliberately keeps
 * extraction, eligibility, conflict and completeness decisions in shared
 * domain helpers; the renderer only decides how much of this model to show.
 */
export function deriveProjectLibraryViewModel(input: {
  project: ProjectMemoryProject;
  facts: ProjectFact[];
  modules?: ProjectMemoryModule[];
  problems?: ProjectProblem[];
  questions?: ProjectInterviewQuestion[];
  sourceCount?: number;
  staleFactCount?: number;
  completeness?: ProjectCompletenessResult;
  analysisRuns?: Array<{ projectId?: string; status: "running" | "completed" | "failed"; updatedAt: number }>;
  analysisRunning?: boolean;
  latestSourceUpdatedAt?: number;
}): ProjectLibraryViewModel {
  const scopedFacts = input.facts.filter((fact) => fact.projectId === input.project.id);
  const eligibleFacts = scopedFacts.filter(isFactEligible);
  const project = deriveProjectView(input.project, scopedFacts);
  const completeness = input.completeness ?? calculateProjectCompleteness({ project: input.project, facts: scopedFacts, modules: input.modules, problems: input.problems, questions: input.questions });
  const conflicts = listConflictGroups(scopedFacts, { projectId: input.project.id });
  const parameters = eligibleFacts.filter((fact) => fact.type === "parameter").sort(byUpdatedAt);
  const decisions = eligibleFacts.filter((fact) => fact.type === "technical_decision" || fact.type === "decision").sort(byUpdatedAt);
  const results = eligibleFacts.filter((fact) => (fact.type === "result" || fact.type === "metric") && !isNotMeasured(fact)).sort(byUpdatedAt);
  const limitations = uniqueFacts([
    ...scopedFacts.filter((fact) => fact.type === "limitation"),
    ...scopedFacts.filter((fact) => (fact.type === "metric" || fact.type === "result") && isNotMeasured(fact))
  ]).sort(byUpdatedAt);
  const problems = (input.problems ?? []).filter((problem) => problem.projectId === input.project.id);
  const modules = (input.modules ?? []).filter((module) => module.projectId === input.project.id);
  const questions = (input.questions ?? []).filter((question) => question.projectId === input.project.id);
  const actions = listUserActions(scopedFacts, input.project.id, input.project.ownershipMode);
  const sourceCount = input.sourceCount ?? project.sourceIds.length;
  const projectRuns = (input.analysisRuns ?? []).filter((run) => run.projectId === input.project.id).sort((left, right) => right.updatedAt - left.updatedAt);
  const latestRun = projectRuns[0];
  const analysisStatus: ProjectAnalysisStatus = sourceCount === 0
    ? "empty"
    : input.analysisRunning || latestRun?.status === "running"
      ? "analyzing"
      : latestRun?.status === "failed"
        ? "failed"
        : eligibleFacts.length === 0
          ? "sources_ready"
          : latestRun && input.latestSourceUpdatedAt && input.latestSourceUpdatedAt > latestRun.updatedAt
            ? "stale"
            : "ready";
  const nextActions: ProjectLibraryNextAction[] = [];
  const needsAnalysis = sourceCount > 0 && (analysisStatus === "sources_ready" || analysisStatus === "analyzing" || analysisStatus === "failed" || analysisStatus === "stale");
  if (needsAnalysis) nextActions.push({ type: "analyze_sources", title: analysisStatus === "analyzing" ? "正在分析项目资料" : "分析已上传资料", description: analysisStatus === "analyzing" ? "正在整理技术事实、参数、决策和问题链。" : `已绑定 ${sourceCount} 份资料，但尚未生成项目技术知识。`, priority: "high" });
  if (!needsAnalysis && parameters.length === 0) nextActions.push({ type: "missing_parameters", title: "补充关键参数", description: "还没有可靠关键参数，补充后可以减少面试时的猜测。", priority: "high" });
  if (!needsAnalysis && decisions.length === 0) nextActions.push({ type: "missing_decisions", title: "补充技术决策", description: "还没有形成 Why 类型事实，记录取舍和原因。", priority: "medium" });
  if (conflicts.length > 0) nextActions.push({ type: "conflict", title: `处理 ${conflicts.length} 个信息冲突`, description: "选择当前采用的版本，保留项目上下文。", priority: "high" });
  if (sourceCount === 0) nextActions.push({ type: "missing_sources", title: "添加项目资料", description: "上传 README、代码或排查记录，让复习内容有证据。", priority: "medium" });

  let technologySlots = 20;
  const technologies = (project.technologyTaxonomy ?? []).map((group) => {
    const items = group.items.slice(0, technologySlots);
    technologySlots -= items.length;
    return { ...group, items };
  }).filter((group) => group.items.length > 0);

  return {
    project,
    summary: sourceCount > 0 && eligibleFacts.length === 0
      ? analysisStatus === "analyzing" ? "正在分析项目资料，完成后会自动生成技术事实、参数、决策和问题链。"
        : analysisStatus === "failed" ? "项目分析失败，请点击“重新分析”重试。"
          : "已上传项目资料，等待项目分析。"
      : project.description.trim() || "暂无明确项目背景说明。可以从资料生成一句项目简介，或手动补充。",
    technologies,
    parameters,
    decisions,
    problems,
    modules,
    questions,
    results,
    limitations,
    conflicts,
    familiarity: {
      overall: completeness.projectFamiliarityScore,
      technical: completeness.technicalCoverageScore,
      parameters: completeness.parameterCoverageScore,
      decisions: completeness.decisionCoverageScore,
      problems: completeness.problemCoverageScore
    },
    status: {
      trustedFacts: eligibleFacts.length,
      pendingActions: input.completeness?.userActions ?? actions.length,
      conflictGroups: conflicts.length,
      staleFacts: input.staleFactCount ?? 0,
      sourceCount
    },
    analysisStatus,
    nextActions: nextActions.slice(0, 3),
    completeness
  };
}
