import { classifyQuestionSemanticFrame } from "../question/semantic-frame";
import type { QuestionSlot } from "../question/question-decomposer";
import type { QuestionFrameType, QuestionRequirement, QuestionRequirementType } from "./question-frame";

function requirement(id: string, type: QuestionRequirementType, description: string, required = true): QuestionRequirement {
  return { id, type, description, required };
}

function requirementsForSlot(slot: QuestionSlot): QuestionRequirement[] {
  const text = slot.question;
  const frame = classifyQuestionSemanticFrame(text);
  const values: QuestionRequirement[] = [];
  if (/什么是|什么意思|定义|指什么/iu.test(text) || frame === "definition") values.push(requirement(`${slot.index}-definition`, "definition", "给出准确结论和定义"));
  if (/原理|怎么工作|如何工作|为什么/iu.test(text) || frame === "cause") values.push(requirement(`${slot.index}-principle`, frame === "cause" ? "reason" : "principle", frame === "cause" ? "解释原因和设计依据" : "解释工作原理"));
  if (/区别|差异|对比|取舍/iu.test(text) || frame === "comparison") values.push(requirement(`${slot.index}-difference`, "difference", "说明核心差异、适用场景和取舍"));
  if (/怎么|如何|实现|使用|用的|模式|流程|步骤/iu.test(text) || frame === "implementation" || frame === "process") values.push(requirement(`${slot.index}-implementation`, frame === "process" ? "process" : "implementation", frame === "process" ? "说明处理流程和关键步骤" : "说明落地方式、数据流和关键配置"));
  if (/架构|分层|模块|链路|组件/iu.test(text)) values.push(requirement(`${slot.index}-architecture`, "architecture", "说明架构、模块边界和数据链路"));
  if (/排查|定位|故障|异常|调试/iu.test(text)) values.push(requirement(`${slot.index}-debugging`, "debugging", "给出可执行的排查顺序和定位依据"));
  if (/验证|测试|如何证明|怎么确认/iu.test(text)) values.push(requirement(`${slot.index}-verification`, "verification", "说明验证方法、观测信号和通过标准"));
  if (/例子|例如|比如|举例/iu.test(text)) values.push(requirement(`${slot.index}-example`, "example", "给出一个贴合题意的工程例子"));
  if (/复杂度|时间复杂度|空间复杂度/iu.test(text)) values.push(requirement(`${slot.index}-complexity`, "complexity", "说明时间、空间复杂度和边界"));
  if (/项目|这个系统|实际使用|简历/iu.test(text)) values.push(requirement(`${slot.index}-project-fact`, "project_fact", "只使用当前项目的已验证事实"));
  return values;
}

/**
 * Produces stable, explicit answer slots from the question frame. This is
 * intentionally local and deterministic: the provider may expand a slot but
 * may not silently drop one.
 */
export function buildQuestionRequirements(question: string, slots: QuestionSlot[], questionType: QuestionFrameType, projectId?: string): QuestionRequirement[] {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (/向量中断|非向量中断|向量终端|非向量终端/iu.test(normalized)) {
    return [
      requirement("vector-definition", "definition", "向量中断的定义和入口含义"),
      requirement("non-vector-definition", "definition", "非向量中断的定义和入口含义"),
      requirement("dispatch-mechanism", "principle", "硬件分发与软件分发机制"),
      requirement("vector-table", "architecture", "中断向量表和入口地址关系"),
      requirement("software-hardware-difference", "difference", "硬件分发与软件查询的差异"),
      requirement("nvic", "implementation", "Cortex-M / NVIC 中的实际实现"),
      requirement("latency", "tradeoff", "响应延迟和工程取舍"),
      requirement("stm32-example", "example", "STM32 中的实际例子")
    ];
  }
  const values = slots.flatMap(requirementsForSlot);
  if (projectId || questionType === "PROJECT") values.push(requirement("project-context", "project_fact", "项目归属和项目技术事实必须可追溯"));
  if (!values.length) values.push(requirement("direct-conclusion", "definition", "先直接回答问题结论"));
  return [...new Map(values.map((item) => [item.id, item])).values()];
}
