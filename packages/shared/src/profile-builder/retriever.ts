import type { ProfileBuilderOutput } from "./types";

export interface ProfileExperienceHit {
  text: string;
  topic?: string;
  evidenceIds: string[];
  score: number;
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/gi) ?? [];
}

function score(query: string, text: string): number {
  const queryTerms = terms(query);
  if (!queryTerms.length) return 0;
  const haystack = text.toLowerCase();
  return queryTerms.filter((term) => haystack.includes(term)).length / queryTerms.length;
}

/** Retrieves grounded project and interview material before generic knowledge. */
export function retrieveProfileExperience(query: string, artifact: ProfileBuilderOutput | undefined, limit = 5): ProfileExperienceHit[] {
  if (!artifact) return [];
  const hits: ProfileExperienceHit[] = [
    ...artifact.answerMaterials.map((item) => ({ text: `问题：${item.question}\n回答素材：${item.answerPoints.join(" ")}`, topic: item.topic, evidenceIds: item.evidenceIds, score: score(query, `${item.question} ${item.answerPoints.join(" ")} ${item.topic ?? ""}`) })),
    ...artifact.projectGraph.nodes.map((item) => ({ text: `项目：${item.name}\n${item.summary}\n亮点：${item.highlights.join("；")}`, topic: item.name, evidenceIds: item.evidenceIds, score: score(query, `${item.name} ${item.summary} ${item.highlights.join(" ")} ${item.skills.join(" ")}`) }))
  ];
  return hits.filter((hit) => hit.score > 0).sort((left, right) => right.score - left.score).slice(0, limit);
}

