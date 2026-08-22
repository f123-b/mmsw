/**
 * Lightweight domain terminology normalizer for ASR and question routing.
 *
 * ASR providers are intentionally kept generic, so a small deterministic
 * vocabulary is applied at the application boundary. The canonical forms are
 * also passed to the question detector and the answer prompt.
 */
export interface TerminologyRule {
  canonical: string;
  pattern: RegExp;
}

export const INTERVIEW_TERMINOLOGY_RULES: readonly TerminologyRule[] = [
  { canonical: "IIC", pattern: /(?:\bi\s*2\s*c\b|\bi\s*i\s*c\b|\bi\s*phone\s*(?:c|see)\b|\biphone\s*c\b|\biphonec\b|爱爱[西c])/gi },
  { canonical: "FreeRTOS", pattern: /\bfree\s*rtos\b/gi },
  { canonical: "RTOS", pattern: /\br\s*t\s*o\s*s\b/gi },
  { canonical: "FOC", pattern: /\bf\s*o\s*c\b/gi },
  { canonical: "SPI", pattern: /\bs\s*p\s*i\b/gi },
  { canonical: "UART", pattern: /\bu\s*a\s*r\s*t\b/gi },
  { canonical: "DMA", pattern: /\bd\s*m\s*a\b/gi },
  { canonical: "PWM", pattern: /\bp\s*w\s*m\b/gi },
  { canonical: "CAN", pattern: /\bc\s*a\s*n\b/gi },
  { canonical: "CPU", pattern: /\bc\s*p\s*u\b/gi },
  { canonical: "GPU", pattern: /\bg\s*p\s*u\b/gi },
  { canonical: "API", pattern: /\ba\s*p\s*i\b/gi },
  { canonical: "TCP/IP", pattern: /\bt\s*c\s*p\s*(?:\/|每)?\s*i\s*p\b/gi },
  { canonical: "WebSocket", pattern: /\bweb\s*socket\b/gi },
  { canonical: "SQLite", pattern: /\bsql\s*lite\b/gi },
  { canonical: "Redis", pattern: /\bredis\b/gi },
  { canonical: "C++", pattern: /(?:\bc\s*plus\s*plus\b|\bc\+\+)/gi },
  { canonical: "C#", pattern: /(?:\bc\s*sharp\b|\bc#)/gi }
];

export function normalizeTechnicalTerms(text: string): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  for (const rule of INTERVIEW_TERMINOLOGY_RULES) normalized = normalized.replace(rule.pattern, rule.canonical);
  return normalized;
}
