import type { ProjectMemorySnapshot } from "./types";

export interface KnowledgeGraphNode {
  id: string;
  type: "project" | "module" | "technical-point" | "problem" | "question";
  label: string;
  description: string;
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  relation: "contains" | "uses" | "solves" | "answers";
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export function buildKnowledgeGraph(snapshot: ProjectMemorySnapshot): KnowledgeGraph {
  const nodes: KnowledgeGraphNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];
  for (const project of snapshot.projects) {
    nodes.push({ id: project.id, type: "project", label: project.name, description: project.description });
    for (const module of snapshot.modules.filter((item) => item.projectId === project.id)) {
      nodes.push({ id: module.id, type: "module", label: module.moduleName, description: module.description });
      edges.push({ from: project.id, to: module.id, relation: "contains" });
    }
    for (const point of snapshot.technicalPoints.filter((item) => item.projectId === project.id)) {
      nodes.push({ id: point.id, type: "technical-point", label: point.topic, description: point.content });
      edges.push({ from: project.id, to: point.id, relation: "uses" });
    }
    for (const problem of snapshot.problems.filter((item) => item.projectId === project.id)) {
      nodes.push({ id: problem.id, type: "problem", label: problem.problem, description: problem.solution });
      edges.push({ from: project.id, to: problem.id, relation: "solves" });
    }
    for (const question of snapshot.interviewQuestions.filter((item) => item.projectId === project.id)) {
      nodes.push({ id: question.id, type: "question", label: question.question, description: question.answerPoints.join(" ") });
      edges.push({ from: project.id, to: question.id, relation: "answers" });
    }
  }
  return { nodes, edges };
}
