import { validateProjectTimeline } from "./project-timeline";
import type { ProjectMemoryProject } from "./types";

export type ProjectDataHealthCode = "invalid_timeline" | "weak_role" | "weak_background";

export interface ProjectDataHealthIssue {
  field: "time" | "role" | "description";
  code: ProjectDataHealthCode;
  message: string;
  value: string;
}

export interface ProjectDataHealthResult {
  needsReanalysis: boolean;
  issues: ProjectDataHealthIssue[];
}

export function calculateProjectDataHealth(project: ProjectMemoryProject): ProjectDataHealthResult {
  const issues: ProjectDataHealthIssue[] = [];
  if (project.time && validateProjectTimeline(project.time).status === "unknown") issues.push({ field: "time", code: "invalid_timeline", message: "项目时间不是可识别的日期范围或周期", value: project.time });
  if (!project.role.trim() || project.role === "资料未明确记录" || project.role.trim().length < 4) issues.push({ field: "role", code: "weak_role", message: "个人职责过短或未明确记录", value: project.role });
  if (!project.description.trim() || project.description.trim().length < 15) issues.push({ field: "description", code: "weak_background", message: "项目背景过短，可能是错误字段抽取", value: project.description });
  return { needsReanalysis: issues.length > 0, issues };
}
