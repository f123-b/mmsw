export type ProjectClaimType = "team_size" | "ownership" | "project_role" | "technology_used" | "hardware_model" | "parameter" | "metric" | "result" | "company" | "internship" | "duration" | "architecture" | "responsibility" | "supplier_info" | "personal_decision";

export interface ProjectClaim {
  text: string;
  type: ProjectClaimType;
  value?: string;
  personal: boolean;
  highRisk: boolean;
}

const RULES: Array<{ type: ProjectClaimType; pattern: RegExp; value?: RegExp; personal?: boolean }> = [
  { type: "team_size", pattern: /(?:我|我们|项目|团队).{0,18}(?:一共|共|有|人数|成员).{0,8}\d+\s*人/iu, value: /\d+\s*人/iu, personal: true },
  { type: "ownership", pattern: /(?:我|我的|本人).{0,18}(?:负责|主导|独立完成|参与|承担)/iu, personal: true },
  { type: "project_role", pattern: /(?:我|我的|本人).{0,18}(?:角色|职责|岗位)/iu, personal: true },
  { type: "technology_used", pattern: /(?:我|我们|项目|系统).{0,28}(?:使用|采用|用了|基于|接入)/iu, personal: true },
  { type: "hardware_model", pattern: /(?:STM\d+[A-Z0-9]*|RK\d+|ESP\d+|芯片|控制板|驱动板|传感器)/iu },
  { type: "parameter", pattern: /(?:极对数|电阻|电感|波特率|频率|带宽|参数).{0,24}\d/iu },
  { type: "metric", pattern: /(?:延迟|耗时|吞吐|占用率|准确率|召回率|精度|\d+(?:\.\d+)?\s*(?:ms|us|秒|%|Hz|MHz|kHz|MB|KB))/iu },
  { type: "result", pattern: /(?:最终|结果|成果|提升|降低|下降|达到|完成|解决).{0,35}/iu },
  { type: "company", pattern: /(?:我|我的|本人).{0,18}(?:公司|单位|企业)/iu, personal: true },
  { type: "internship", pattern: /(?:我|我的|本人).{0,18}(?:实习|工作经历)/iu, personal: true },
  { type: "duration", pattern: /(?:我|我们|项目).{0,18}\d+\s*(?:天|周|个月|年)/iu, personal: true },
  { type: "architecture", pattern: /(?:项目|系统|架构|模块).{0,22}(?:分层|解耦|状态机|链路|服务)/iu },
  { type: "responsibility", pattern: /(?:我|我的|本人).{0,18}(?:职责|负责|承担)/iu, personal: true },
  { type: "supplier_info", pattern: /(?:供应商|厂家|供应资料|电机参数).{0,24}/iu },
  { type: "personal_decision", pattern: /(?:我|我们).{0,18}(?:决定|选择|取舍|改成|采用)/iu, personal: true }
];

const HIGH_RISK = new Set<ProjectClaimType>(["team_size", "ownership", "project_role", "technology_used", "hardware_model", "parameter", "metric", "result", "company", "internship", "duration", "responsibility", "supplier_info", "personal_decision"]);
const PROJECT_FACT_TYPES = new Set<ProjectClaimType>(["hardware_model", "parameter", "metric", "result", "supplier_info"]);

function isPersonalClaim(rule: { type: ProjectClaimType; personal?: boolean }, sentence: string): boolean {
  if (rule.personal) return true;
  if (PROJECT_FACT_TYPES.has(rule.type)) return /(?:我|我们|我的|本人|项目|系统|实际|当时|团队|硬件|电机|供应商|达到|成果|结果)/iu.test(sentence);
  return /(?:我|我们|我的|本人|项目中|实际)/iu.test(sentence);
}

export function extractProjectClaims(answer: string): ProjectClaim[] {
  const claims: ProjectClaim[] = [];
  for (const sentence of answer.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter(Boolean)) {
    for (const rule of RULES) {
      if (!rule.pattern.test(sentence)) continue;
      const existing = claims.find((claim) => claim.text === sentence && claim.type === rule.type);
      if (existing) continue;
      const value = rule.value?.exec(sentence)?.[0];
      claims.push({ text: sentence, type: rule.type, ...(value ? { value } : {}), personal: isPersonalClaim(rule, sentence), highRisk: HIGH_RISK.has(rule.type) });
    }
  }
  return claims;
}
