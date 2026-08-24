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

export interface TerminologyCorrection {
  raw: string;
  canonical: string;
  source: "embedded" | "general";
}

/**
 * The built-in vocabulary intentionally covers the words most often heard
 * in embedded interviews. It is applied locally at the final-transcript
 * boundary, so it does not add another paid model request to the ASR hot
 * path. Project-specific terms can be layered on top by callers later.
 */
export const EMBEDDED_TERMINOLOGY_RULES: readonly TerminologyRule[] = [
  { canonical: "堆和栈", pattern: /(?:追|堆)\s*(?:和|与|跟)\s*栈/g },
  { canonical: "堆", pattern: /追(?=\s*(?:栈|和|与|、)?\s*(?:栈|内存|管理|溢出|分配|malloc|free))/gi },
  { canonical: "CAN FD", pattern: /c\s*a\s*n\s*(?:f\s*d|fd)/gi },
  { canonical: "FreeRTOS 任务", pattern: /free\s*rtos\s*(?:任務|任务)/gi },
  { canonical: "PendSV", pattern: /p\s*e\s*n\s*d\s*s\s*v/gi },
  { canonical: "SysTick", pattern: /sys\s*tick/gi },
  { canonical: "Cortex-M", pattern: /cortex\s*[- ]?\s*m/gi },
  { canonical: "Cortex-A", pattern: /cortex\s*[- ]?\s*a/gi },
  { canonical: "Cortex-R", pattern: /cortex\s*[- ]?\s*r/gi },
  { canonical: "ARM64", pattern: /arm\s*64|aarch\s*64/gi },
  { canonical: "AArch32", pattern: /aarch\s*32/gi },
  { canonical: "ARMv7-M", pattern: /arm\s*v?\s*7\s*[- ]?\s*m/gi },
  { canonical: "ARMv8-M", pattern: /arm\s*v?\s*8\s*[- ]?\s*m/gi },
  { canonical: "STM32", pattern: /s\s*t\s*m\s*32/gi },
  { canonical: "ESP32", pattern: /e\s*s\s*p\s*32/gi },
  { canonical: "MCU", pattern: /\bm\s*c\s*u\b/gi },
  { canonical: "SoC", pattern: /\bs\s*o\s*c\b/gi },
  { canonical: "DSP", pattern: /\bd\s*s\s*p\b/gi },
  { canonical: "FPGA", pattern: /\bf\s*p\s*g\s*a\b/gi },
  { canonical: "CMSIS", pattern: /\bc\s*m\s*s\s*i\s*s\b/gi },
  { canonical: "HAL", pattern: /\bh\s*a\s*l\b/gi },
  { canonical: "LL 库", pattern: /\bl\s*l\s*(?:库|library)\b/gi },
  { canonical: "BSP", pattern: /\bb\s*s\s*p\b/gi },
  { canonical: "SDK", pattern: /\bs\s*d\s*k\b/gi },
  { canonical: "FreeRTOS", pattern: /free\s*rtos/gi },
  { canonical: "RT-Thread", pattern: /r\s*t\s*[- ]?\s*thread/gi },
  { canonical: "Zephyr", pattern: /z\s*e\s*p\s*h\s*y\s*r/gi },
  { canonical: "U-Boot", pattern: /u\s*[- ]?\s*boot|uboot/gi },
  { canonical: "IIC", pattern: /i\s*2\s*c|i\s*i\s*c|i\s*phone\s*c|iphone\s*c/gi },
  { canonical: "UART", pattern: /u\s*a\s*r\s*t/gi },
  { canonical: "RS-485", pattern: /r\s*s\s*[- ]?\s*4\s*8\s*5/gi },
  { canonical: "RS-232", pattern: /r\s*s\s*[- ]?\s*2\s*3\s*2/gi },
  { canonical: "USB CDC", pattern: /u\s*s\s*b\s*c\s*d\s*c/gi },
  { canonical: "USB HID", pattern: /u\s*s\s*b\s*h\s*i\s*d/gi },
  { canonical: "Ethernet", pattern: /e\s*t\s*h\s*e\s*r\s*n\s*e\s*t/gi },
  { canonical: "QSPI", pattern: /q\s*s\s*p\s*i/gi },
  { canonical: "SDIO", pattern: /s\s*d\s*i\s*o/gi },
  { canonical: "SDMMC", pattern: /s\s*d\s*m\s*m\s*c/gi },
  { canonical: "BLE", pattern: /b\s*l\s*e/gi },
  { canonical: "Wi-Fi", pattern: /wi\s*[- ]?\s*fi/gi },
  { canonical: "ISR", pattern: /i\s*s\s*r/gi },
  { canonical: "IRQ", pattern: /i\s*r\s*q/gi },
  { canonical: "NMI", pattern: /n\s*m\s*i/gi },
  { canonical: "HardFault", pattern: /hard\s*fault/gi },
  { canonical: "MemManage", pattern: /mem\s*manage/gi },
  { canonical: "BusFault", pattern: /bus\s*fault/gi },
  { canonical: "UsageFault", pattern: /usage\s*fault/gi },
  { canonical: "SVC", pattern: /s\s*v\s*c/gi },
  { canonical: "D-Cache", pattern: /d\s*[- ]?\s*cache/gi },
  { canonical: "I-Cache", pattern: /i\s*[- ]?\s*cache/gi },
  { canonical: "volatile", pattern: /v\s*o\s*l\s*a\s*t\s*i\s*l\s*e/gi },
  { canonical: "atomic", pattern: /a\s*t\s*o\s*m\s*i\s*c/gi },
  { canonical: "spinlock", pattern: /spin\s*lock/gi },
  { canonical: "semaphore", pattern: /s\s*e\s*m\s*a\s*p\s*h\s*o\s*r\s*e/gi },
  { canonical: "mutex", pattern: /m\s*u\s*t\s*e\s*x/gi },
  { canonical: "PSP", pattern: /p\s*s\s*p/gi },
  { canonical: "MSP", pattern: /m\s*s\s*p/gi },
  { canonical: "xPSR", pattern: /x\s*p\s*s\s*r/gi },
  { canonical: "CPSR", pattern: /c\s*p\s*s\s*r/gi },
  { canonical: "SPSR", pattern: /s\s*p\s*s\s*r/gi },
  { canonical: "NVIC", pattern: /n\s*v\s*i\s*c/gi },
  { canonical: "SCB", pattern: /s\s*c\s*b/gi },
  { canonical: "JTAG", pattern: /j\s*t\s*a\s*g/gi },
  { canonical: "SWD", pattern: /s\s*w\s*d/gi },
  { canonical: "ST-Link", pattern: /s\s*t\s*[- ]?\s*l\s*i\s*n\s*k/gi },
  { canonical: "Clarke", pattern: /c\s*l\s*a\s*r\s*k/gi },
  { canonical: "Park", pattern: /p\s*a\s*r\s*k/gi },
  { canonical: "SVPWM", pattern: /s\s*v\s*p\s*w\s*m/gi },
  { canonical: "PID", pattern: /p\s*i\s*d/gi },
  { canonical: "FOC", pattern: /f\s*o\s*c/gi },
  { canonical: "DMA", pattern: /d\s*m\s*a/gi },
  { canonical: "ADC", pattern: /a\s*d\s*c/gi },
  { canonical: "DAC", pattern: /d\s*a\s*c/gi },
  { canonical: "GPIO", pattern: /g\s*p\s*i\s*o/gi },
  { canonical: "PWM", pattern: /p\s*w\s*m/gi },
  { canonical: "CAN", pattern: /c\s*a\s*n/gi },
  { canonical: "MQTT", pattern: /m\s*q\s*t\s*t/gi },
  { canonical: "Modbus", pattern: /m\s*o\s*d\s*b\s*u\s*s/gi },
  { canonical: "TCP/IP", pattern: /t\s*c\s*p\s*(?:\/|每)?\s*i\s*p/gi },
  { canonical: "Socket", pattern: /s\s*o\s*c\s*k\s*e\s*t/gi },
  { canonical: "I/O", pattern: /i\s*[\/或]\s*o/gi },
  { canonical: "Cache", pattern: /c\s*a\s*c\s*h\s*e/gi },
  { canonical: "MMU", pattern: /m\s*m\s*u/gi },
  { canonical: "MPU", pattern: /m\s*p\s*u/gi },
  { canonical: "TLB", pattern: /t\s*l\s*b/gi },
  { canonical: "Buildroot", pattern: /b\s*u\s*i\s*l\s*d\s*r\s*o\s*o\s*t/gi },
  { canonical: "Yocto", pattern: /y\s*o\s*c\s*t\s*o/gi },
  { canonical: "Device Tree", pattern: /device\s*tree|设备\s*树/gi }
];

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

function applyRules(text: string, rules: readonly TerminologyRule[], source: TerminologyCorrection["source"], corrections: TerminologyCorrection[]): string {
  let normalized = text;
  for (const rule of rules) {
    normalized = normalized.replace(rule.pattern, (raw) => {
      if (raw !== rule.canonical) corrections.push({ raw, canonical: rule.canonical, source });
      return rule.canonical;
    });
  }
  return normalized;
}

export function normalizeTechnicalTermsWithCorrections(text: string): { text: string; corrections: TerminologyCorrection[] } {
  const corrections: TerminologyCorrection[] = [];
  let normalized = text.replace(/\s+/g, " ").trim();
  normalized = applyRules(normalized, EMBEDDED_TERMINOLOGY_RULES, "embedded", corrections);
  normalized = applyRules(normalized, INTERVIEW_TERMINOLOGY_RULES, "general", corrections);
  return { text: normalized, corrections };
}

export function normalizeTechnicalTerms(text: string): string {
  return normalizeTechnicalTermsWithCorrections(text).text;
}
