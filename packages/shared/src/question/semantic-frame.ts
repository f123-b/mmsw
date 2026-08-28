import { normalizeTechnicalTerms } from "../terminology";

export type QuestionSemanticFrame =
  | "definition"
  | "enumeration"
  | "comparison"
  | "mechanism"
  | "process"
  | "keyword"
  | "cause"
  | "failure_effect"
  | "troubleshooting"
  | "implementation"
  | "architecture"
  | "selection_tradeoff"
  | "personal_fact"
  | "behavioral"
  | "salary"
  | "company"
  | "multi_slot"
  | "code"
  | "general";

/** Deterministic semantic framing used to route answers and audit coverage. */
export function classifyQuestionSemanticFrame(text: string, kind?: string): QuestionSemanticFrame {
  const normalized = normalizeTechnicalTerms(text).trim();
  const multiSlot = (normalized.match(/[？?]/g)?.length ?? 0) >= 2 || /(?:分别|同时回答|几个方面|以及).{2,}(?:多少|什么|为什么|如何)/.test(normalized);
  if (multiSlot) return "multi_slot";
  if (/薪资|薪酬|工资|期望|年薪|月薪|待遇|到手/.test(normalized)) return "salary";
  if (/公司|贵司|贵公司|业务|产品|为什么想来|为什么选择我们|了解我们|岗位匹配/.test(normalized)) return "company";
  if (kind === "behavior" || /团队|冲突|压力|困难|失败|沟通|协作|领导|决策经历|案例/.test(normalized) && /你|我|经历|遇到/.test(normalized)) return "behavioral";
  if (/代码|手写|补全|伪代码|算法题|时间复杂度|空间复杂度|输出结果|leetcode|修复这段/.test(normalized)) return "code";
  if (/你负责|你做过|你的项目|个人经历|你主导|你实现|你用过|简历|业绩|成果|指标/.test(normalized)) return "personal_fact";
  if (/系统设计|架构设计|设计一个系统|高并发|可扩展|容灾|服务拆分|数据库设计|缓存设计/.test(normalized)) return "architecture";
  if (/排查|定位|故障|报错|异常|怎么解决|如何解决|怎么验证|监控|告警|丢帧|卡死|抖动/.test(normalized)) return "troubleshooting";
  if (/怎么实现|如何实现|具体实现|怎么写|如何写|配置|接入|落地|代码实现/.test(normalized)) return "implementation";
  if (/为什么不用|怎么选|如何选择|选型|权衡|取舍|优缺点|适合什么场景|差异/.test(normalized)) return "selection_tradeoff";
  if (/为什么|为何|原因|导致|影响因素/.test(normalized)) return "cause";
  if (/错误|错误码|现象|故障|会发生什么|有什么后果|风险|副作用/.test(normalized)) return "failure_effect";
  if (/关键字|关键点|注意事项|常见误区|volatile|static|const|指针|自增|自减|\+\+p|p\+\+/.test(normalized)) return "keyword";
  if (/流程|步骤|顺序|从.+到|进入|触发|生命周期|执行过程/.test(normalized)) return "process";
  if (/原理|机制|仲裁|为什么能|底层|怎么工作的/.test(normalized)) return "mechanism";
  if (/有哪些|哪几个|列举|分别|包括|常见的/.test(normalized)) return "enumeration";
  if (/区别|对比|比较|不同/.test(normalized)) return "comparison";
  if (/什么是|是什么|定义|含义|作用|介绍|讲一下|说一下/.test(normalized)) return "definition";
  return "general";
}
