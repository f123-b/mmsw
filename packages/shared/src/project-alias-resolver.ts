import { normalizeTechnicalTerms } from "./terminology";

export interface ProjectAliasCandidate {
  id: string;
  name: string;
  aliases?: readonly string[];
  entities?: readonly string[];
}

export interface ProjectAliasResolution {
  projectId?: string;
  projectName?: string;
  confidence: number;
  ambiguous: boolean;
  reason: "exact-id" | "exact-name" | "alias" | "entity-overlap" | "token-overlap" | "ambiguous" | "none";
  candidates: string[];
}

function compact(text: string): string {
  return normalizeTechnicalTerms(text).toLowerCase().replace(/[\s，。！？?！、；;：:（）()]/g, "");
}

function tokens(text: string): Set<string> {
  const generic = new Set(["项目", "系统", "模块", "方案", "这个", "那个"]);
  const value = compact(text);
  const result = new Set(value.match(/[a-z0-9+#./-]+/g) ?? []);
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2);
    if (/^[\u4e00-\u9fff]{2}$/u.test(pair) && !generic.has(pair)) result.add(pair);
  }
  return result;
}

/** Resolves a spoken project reference without silently picking between ties. */
export class ProjectAliasResolver {
  resolve(text: string, projects: readonly ProjectAliasCandidate[]): ProjectAliasResolution {
    const query = compact(text);
    if (!query || projects.length === 0) return { confidence: 0, ambiguous: false, reason: "none", candidates: [] };
    const exactId = projects.find((project) => query === compact(project.id));
    if (exactId) return { projectId: exactId.id, projectName: exactId.name, confidence: 1, ambiguous: false, reason: "exact-id", candidates: [exactId.id] };
    const scored = projects.map((project) => {
      const aliases = [project.name, ...(project.aliases ?? []), ...(project.entities ?? [])].map(compact).filter(Boolean);
      const exact = aliases.find((alias) => query.includes(alias) || alias.includes(query));
      const queryTokens = tokens(text);
      const projectTokens = new Set(aliases.flatMap((alias) => [...tokens(alias)]));
      const overlap = [...queryTokens].filter((token) => projectTokens.has(token)).length;
      return { project, score: exact ? 0.98 : overlap, exact: Boolean(exact) };
    }).filter((item) => item.exact || item.score > 0).sort((left, right) => right.score - left.score);
    if (!scored.length) return { confidence: 0, ambiguous: false, reason: "none", candidates: [] };
    const top = scored[0];
    const tied = scored.filter((item) => item.score >= top.score - 0.06);
    if (tied.length > 1) return { confidence: top.score, ambiguous: true, reason: "ambiguous", candidates: tied.map((item) => item.project.id) };
    const confidence = top.exact ? top.score : Math.min(0.9, 0.5 + top.score * 0.15);
    return { projectId: top.project.id, projectName: top.project.name, confidence, ambiguous: false, reason: top.exact ? "alias" : top.score >= 2 ? "entity-overlap" : "token-overlap", candidates: [top.project.id] };
  }
}
