import type { AnswerPlan } from "./answer-planner";
import { AnswerLengthController } from "./answer-length-controller";

export interface AnswerCoverageResult {
  requiredFacets: string[];
  coveredFacets: string[];
  missingFacets: string[];
  characterCount: number;
  estimatedDurationSec: number;
  lengthPass: boolean;
  structurePass: boolean;
  depthPass: boolean;
  needsRepair: boolean;
}

const FACET_PATTERNS: Record<string, RegExp> = {
  definition: /(?:是指|指的是|本质上|定义|一种|用来|解决的是|简单说)/iu,
  mechanism: /(?:原理|机制|流程|主从|时钟|同步|数据流|调用链|工作方式|通过|先.*再|步骤)/iu,
  key_characteristics: /(?:特点|特性|关键点|全双工|半双工|CPOL|CPHA|MOSI|MISO|SCK|CS|优点|缺点|区别|取舍)/iu,
  practical_consideration: /(?:实际|工程|调试|注意|排查|验证|适用|风险|异常|边界|兼容|时序|抓波形|日志)/iu,
  conclusion: /(?:可以|不能|应该|建议|结论|核心是|关键是|我会|优先)/iu,
  key_differences: /(?:区别|不同|差异|相比|而另一个|对比|取舍)/iu,
  common_causes: /(?:原因|常见原因|泄漏|未释放|越界|碎片|错误|失控)/iu,
  consequences: /(?:后果|结果|导致|影响|崩溃|耗尽|异常|风险)/iu,
  embedded_example: /(?:嵌入式|MCU|中断|RTOS|驱动|设备|传感器|工程中|例如|比如)/iu,
  architecture: /(?:架构|分层|模块|组件|数据流|链路)/iu,
  responsibility: /(?:我负责|我参与|我主导|我的职责|我主要|在项目中)/iu,
  implementation: /(?:实现|设计|代码|接口|状态机|队列|缓存|调用|落地)/iu,
  challenge: /(?:问题|挑战|故障|难点|冲突|异常|瓶颈)/iu,
  result: /(?:结果|效果|提升|下降|稳定|验证通过|最终|指标)/iu,
  verification: /(?:验证|测试|压测|回归|日志|监控|波形|复现)/iu,
  diagnosis_order: /(?:先看|第一步|排查顺序|定位|检查|确认)/iu,
  root_cause: /(?:根因|原因是|因为|定位到|最终发现)/iu,
  fix: /(?:修复|改成|处理|解决|替换|增加|避免)/iu,
  code: /```|(?:函数|代码|实现)/iu,
  complexity_and_edges: /(?:时间复杂度|空间复杂度|复杂度|边界|空指针|空数组|异常情况)/iu,
  context: /(?:背景|场景|当时|项目中|情况)/iu,
  task: /(?:任务|目标|需要|负责解决)/iu,
  action: /(?:我|采取|通过|做了|实现|设计|排查)/iu,
  reflection: /(?:复盘|反思|经验|以后|改进)/iu,
  new_detail: /(?:具体|另外|补充|细节|新增|这里)/iu,
  direct_reason: /(?:因为|原因|所以|关键)/iu,
  contextual_example: /(?:比如|例如|在这个项目|实际|场景)/iu,
  direct_explanation: /(?:也就是说|换句话说|指的是|简单说|本质)/iu,
  short_example: /(?:比如|例如|举例|像)/iu
};

function unique(values: string[]): string[] { return [...new Set(values)]; }

function requiredFacets(plan: AnswerPlan): string[] {
  const structure = plan.structure.length ? plan.structure : ["conclusion", "mechanism"];
  if (plan.kind === "concept") return unique(["definition", "mechanism", "key_characteristics", "practical_consideration"]);
  if (plan.kind === "comparison") return unique(["definition", "key_differences", "common_causes", "consequences", "embedded_example"]);
  if (plan.kind === "project") return unique(["architecture", "responsibility", "implementation", "challenge", "result", ...structure]);
  if (plan.kind === "system-design") return unique(["conclusion", "architecture", "implementation", "practical_consideration", "verification"]);
  if (plan.kind === "embedded-debugging" || plan.kind === "troubleshooting") return unique(["conclusion", "diagnosis_order", "root_cause", "fix", "verification"]);
  if (plan.kind === "code") return unique(["code", "complexity_and_edges", ...structure]);
  return unique(structure);
}

/** Checks answer depth against the already selected AnswerPlan. */
export class AnswerPlanCoverageChecker {
  constructor(private readonly lengthController = new AnswerLengthController()) {}

  check(plan: AnswerPlan, answer: string): AnswerCoverageResult {
    const required = requiredFacets(plan);
    const covered = required.filter((facet) => FACET_PATTERNS[facet]?.test(answer) ?? (answer.length > 0 && answer.includes(facet)));
    const missing = required.filter((facet) => !covered.includes(facet));
    const characterCount = answer.replace(/\s/g, "").length;
    const estimatedDurationSec = this.lengthController.estimateDurationSec(answer);
    const lengthPass = characterCount >= plan.length.minCharacters && characterCount <= plan.length.maxCharacters;
    const structurePass = required.length === 0 || covered.length / required.length >= (required.length <= 3 ? 0.67 : 0.75);
    const depthPass = missing.length === 0 || covered.length / required.length >= 0.75;
    return { requiredFacets: required, coveredFacets: covered, missingFacets: missing, characterCount, estimatedDurationSec, lengthPass, structurePass, depthPass, needsRepair: !lengthPass || !structurePass || !depthPass };
  }
}

export function answerPlanFacets(plan: AnswerPlan): string[] { return requiredFacets(plan); }
