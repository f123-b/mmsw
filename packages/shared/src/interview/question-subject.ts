import { normalizeTechnicalTerms } from "../terminology";

// Entities spoken in this question. Context entities live separately and must
// never make a fragment look as though its subject has actually been heard.
const TERMS = ["STM32F405", "STM32F4", "F405", "DMA", "ADC", "PWM", "CAN", "UART", "I2C", "SPI", "FOC", "ABZ", "Id", "Iq", "编码器", "定时器", "中心对齐", "摩擦状态机", "抗齿槽补偿", "FreeRTOS", "RTOS", "Linux", "HardFault", "stack", "interrupt", "exception", "栈", "非向量中断", "向量中断", "中断", "异常", "Cortex-M", "NVIC", "C语言", "C++", "volatile", "电机", "线程", "进程", "函数指针", "指针", "数组", "内存", "地址泄露", "地址泄漏", "MQTT", "Modbus", "TCP", "UDP"];

export function spokenEntities(text: string): string[] {
  const normalized = normalizeTechnicalTerms(text).replace(/\bIIC\b/giu, "I2C");
  return TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${/^[A-Za-z]/.test(term) ? "(?<![A-Za-z0-9])" : ""}${escaped}${/[A-Za-z0-9]$/.test(term) ? "(?![A-Za-z0-9])" : ""}`, "iu").test(normalized);
  }).filter((term, _index, all) => !all.some((other) => other !== term && other.includes(term)));
}

export function cleanQuestionDiscourse(text: string): string {
  return text.trim()
    .replace(/^(?:(?:嗯+|呃+|啊+|好的|好)[，,。\s]+)+/u, "")
    .replace(/^(?:那)?我们开始面试(?:啊|吧)?[。！!，,\s]*(?:嗯[。\s]*)?/u, "")
    .replace(/(?:[。！？?！\s]+(?:嗯+|呃+|啊+|好|好的|对)[。！？?！\s]*)+$/u, "")
    .trim();
}

/** Recognize subjects outside the technical entity dictionary (HR and new technologies). */
export function hasSpokenQuestionContent(text: string): boolean {
  const value = cleanQuestionDiscourse(text);
  if (!/(?:什么|怎么|如何|为什么|为何|哪些|多少|是否|有没有|吗|呢|介绍|解释|说说|讲讲|[？?])/u.test(value)) return false;
  const content = value
    .replace(/(?:为什么|为何|怎么样|怎么|如何|什么|哪些|哪个|多少|是否|有没有|能不能|可不可以|介绍一下|解释一下|说说|讲讲)/gu, "")
    .replace(/(?:你觉得|你认为|你们|我们|你|您|我|它|这个|那个|这样|那样|这里|那里|一下)/gu, "")
    .replace(/[的了是在有要会能请那这吗呢啊吧呀嘛哦嗯\s，。！？?！、；;：:]/gu, "");
  return content.length >= 2;
}

export function isTopicOnlyFragment(text: string): boolean {
  const value = cleanQuestionDiscourse(normalizeTechnicalTerms(text)).replace(/^(?:那|那么|关于|说到|再看)[，,\s]*/u, "").replace(/^(?:你|您)?(?:这个|那个)\s*/u, "").replace(/总线[。！？?！\s]*$/u, "").replace(/[。！？?！\s]/gu, "");
  return spokenEntities(value).some((entity) => entity.toLowerCase() === value.toLowerCase());
}
