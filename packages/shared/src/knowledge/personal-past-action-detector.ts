import { normalizeTechnicalTerms } from "../terminology";

export interface PersonalPastActionFinding {
  sentence: string;
  supported: boolean;
  reason: string;
}

export interface PersonalPastActionDecision {
  findings: PersonalPastActionFinding[];
  unsupported: PersonalPastActionFinding[];
  unsupportedCount: number;
}

const PAST_MARKER = /(?:我之前|我当时|我在项目里|我在项目中|我们项目|曾经|实际|最后定位|最后解决|做过|用过|调过|负责过|实现过|采用过)/u;
const ACTION = /(?:负责|主导|设计|实现|定位|解决|调试|使用|采用|优化|排查|修复|完成|搭建|开发)/u;
const HYPOTHETICAL = /(?:我会|我将|我先|如果.*我|可以先|通常会|建议先|应该先)/u;

function compact(text: string): string {
  return normalizeTechnicalTerms(text).toLowerCase().replace(/[\s，。！？?！、；;：:（）()]/g, "");
}

/** Finds historical first-person actions while leaving hypothetical plans alone. */
export class PersonalPastActionDetector {
  detect(answer: string, evidence: readonly string[] = []): PersonalPastActionDecision {
    const source = evidence.map(compact).filter(Boolean);
    const findings = answer.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter(Boolean).flatMap((sentence) => {
      if (!PAST_MARKER.test(sentence) || !ACTION.test(sentence) || HYPOTHETICAL.test(sentence)) return [];
      const normalized = compact(sentence);
      const supported = source.some((item) => item.includes(normalized) || normalized.includes(item) || [...new Set(normalized.match(/[a-z0-9+#]+|[\u4e00-\u9fff]{2}/g) ?? [])].filter((token) => item.includes(token)).length >= 2);
      return [{ sentence, supported, reason: supported ? "historical-action-supported" : "historical-action-without-evidence" }];
    });
    const unsupported = findings.filter((finding) => !finding.supported);
    return { findings, unsupported, unsupportedCount: unsupported.length };
  }
}
