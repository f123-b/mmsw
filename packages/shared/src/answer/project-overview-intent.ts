/** Narrow aliases for whole-project questions, never component questions. */
export function projectOverviewIntent(text: string): "responsibility" | "architecture" | undefined {
  const value = text.replace(/^\s*(?:Q\s*\d+|\d+)\s*[：:｜|、.．)）-]\s*/iu, "");
  if (!/项目|系统/u.test(value)) return undefined;
  if (/(?:模块|硬件|软件|驱动|算法|任务|线程|通信|采样|中断|团队|几个人|多久|难点|为什么|哪些问题|贡献|ADC|DMA|PWM|SPI|I2C)/iu.test(value)) return undefined;
  const intent = /负责|职责/u.test(value) ? "responsibility" : /架构/u.test(value) ? "architecture" : undefined;
  if (!intent) return undefined;
  // Only harmless discourse and project labels may surround the nucleus.
  // An unrecognized qualifier keeps the normal score/margin route intact.
  const remaining = value
    .replace(/[A-Za-z0-9+-]+(?=项目)/gu, "")
    .replace(/来讲一讲|讲一讲|介绍一下|讲一下|说一下|说说|整体|总体|主要|这个|那个|哪些|什么|怎么|如何|设计|划分|负责|职责|架构|项目|系统|部分|工作|内容|简单|具体/g, "")
    .replace(/[你您那的在里中是了有做呢吗吧先来\s\p{P}\p{S}]/gu, "");
  return remaining ? undefined : intent;
}
