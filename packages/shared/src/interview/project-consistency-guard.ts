import type { ActiveProjectState } from "./project-context-state";

export type ProjectConsistencyDecision = "ALLOW" | "LOW_CONFIDENCE" | "PROJECT_ENTITY_CONFLICT";

export interface ProjectConsistencyResult {
  decision: ProjectConsistencyDecision;
  confidence: number;
  reason: string;
  conflictingEntities: string[];
  correctionCandidate?: string;
}

const FOC_ENTITIES = /(?:FOC|电机|机器人|关节|SVPWM|电流环|速度环|编码器|ADC|PWM)/iu;
const ELEVATOR_ENTITIES = /(?:电梯|轿厢|导轨|舒适度|S曲线)/iu;
const NETWORK_ENTITIES = /(?:Linux|网关|多协议|Modbus|WebSocket|设备管理)/iu;

/** Detects a single ASR world-model jump without mutating active project state. */
export class ProjectConsistencyGuard {
  evaluate(text: string, activeProject?: ActiveProjectState): ProjectConsistencyResult {
    const normalized = text.trim();
    if (!activeProject) return { decision: "ALLOW", confidence: 0.6, reason: "no-active-project", conflictingEntities: [] };
    const joined = `${activeProject.projectName ?? ""} ${activeProject.entities.join(" ")} ${activeProject.topics.join(" ")}`;
    if (FOC_ENTITIES.test(joined) && ELEVATOR_ENTITIES.test(normalized) && !ELEVATOR_ENTITIES.test(joined)) return { decision: "PROJECT_ENTITY_CONFLICT", confidence: 0.12, reason: "elevator-term-conflicts-with-foc-context", conflictingEntities: normalized.match(/电梯|轿厢|导轨|舒适度|S曲线/giu) ?? [], correctionCandidate: "电机/机器人关节" };
    if (NETWORK_ENTITIES.test(joined) && /电梯|轿厢|导轨/iu.test(normalized)) return { decision: "PROJECT_ENTITY_CONFLICT", confidence: 0.16, reason: "hardware-world-model-conflict", conflictingEntities: normalized.match(/电梯|轿厢|导轨/giu) ?? [] };
    const known = activeProject.entities.filter((entity) => normalized.toLocaleLowerCase().includes(entity.toLocaleLowerCase()));
    return known.length ? { decision: "ALLOW", confidence: Math.min(0.99, 0.75 + known.length * 0.05), reason: "project-entity-supported", conflictingEntities: [] } : { decision: "LOW_CONFIDENCE", confidence: 0.55, reason: "new-entity-needs-project-evidence", conflictingEntities: [] };
  }
}

export function checkProjectConsistency(text: string, activeProject?: ActiveProjectState): ProjectConsistencyResult {
  return new ProjectConsistencyGuard().evaluate(text, activeProject);
}
