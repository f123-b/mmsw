import { normalizeTechnicalTerms } from "../terminology";

// Entities spoken in this question. Context entities live separately and must
// never make a fragment look as though its subject has actually been heard.
const TERMS = ["STM32F405", "STM32F4", "F405", "DMA", "ADC", "PWM", "CAN", "UART", "I2C", "SPI", "FOC", "FreeRTOS", "RTOS", "Linux", "HardFault", "stack", "interrupt", "exception", "栈", "非向量中断", "向量中断", "中断", "异常", "Cortex-M", "NVIC", "C语言", "C++", "volatile", "电机", "线程", "进程", "函数指针", "指针", "数组", "内存", "地址泄露", "地址泄漏", "MQTT", "Modbus", "TCP", "UDP"];

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
    .replace(/(?:[。！？?！\s]+(?:嗯+|呃+|啊+|好|好的|对)[。！？?！\s]*)+$/u, "")
    .trim();
}

export function isTopicOnlyFragment(text: string): boolean {
  const value = cleanQuestionDiscourse(normalizeTechnicalTerms(text)).replace(/^(?:那|那么|关于|说到|再看)[，,\s]*/u, "").replace(/[。！？?！\s]/gu, "");
  return spokenEntities(value).some((entity) => entity.toLowerCase() === value.toLowerCase());
}
