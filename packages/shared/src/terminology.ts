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
  context?: RegExp;
  priority?: number;
  source?: "embedded" | "general" | "project";
}

export interface TerminologyCorrection {
  raw: string;
  canonical: string;
  source: "embedded" | "general" | "project";
  confidence?: number;
  reason?: string;
  context?: string;
}

export interface TerminologyDictionary {
  readonly rules: readonly TerminologyRule[];
  add(rule: TerminologyRule): void;
  addMany(rules: readonly TerminologyRule[]): void;
}

/**
 * The built-in vocabulary intentionally covers the words most often heard
 * in embedded interviews. It is applied locally at the final-transcript
 * boundary, so it does not add another paid model request to the ASR hot
 * path. Project-specific terms can be layered on top by callers later.
 */
export const EMBEDDED_TERMINOLOGY_RULES: readonly TerminologyRule[] = [
  { canonical: "堆和栈", pattern: /(?:杯和盏|杯和栈|堆和盏|追和栈)/g, priority: 120 },
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
  { canonical: "STM32", pattern: /s\s*t\s*m\s*(?:三二|3\s*2)/gi, priority: 120 },
  { canonical: "EEPROM", pattern: /(?:e\s*p\s*room|e\s*p\s*rom|e\s*e\s*p\s*r\s*o\s*m|eeprom)/gi, priority: 120 },
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
  { canonical: "FOC", pattern: /\bf\s*o\s*c\b/gi, priority: 100 },
  { canonical: "DMA", pattern: /\bd\s*m\s*a\b/gi, priority: 100 },
  { canonical: "ADC", pattern: /a\s*d\s*c/gi },
  { canonical: "DAC", pattern: /d\s*a\s*c/gi },
  { canonical: "GPIO", pattern: /g\s*p\s*i\s*o/gi },
  { canonical: "PWM", pattern: /p\s*w\s*m/gi },
  { canonical: "CAN", pattern: /\bc\s*a\s*n\b/gi, priority: 100 },
  { canonical: "CAN", pattern: /(?:看|砍|坎|康)(?=\s*(?:总线|FD|协议|报文|仲裁|节点|收发器|控制器))/g, priority: 120 },
  { canonical: "CAN FD", pattern: /(?:看|砍|坎|康)\s*f\s*d/gi, priority: 120 },
  { canonical: "LIN", pattern: /\bl\s*i\s*n\b/gi },
  { canonical: "FlexRay", pattern: /flex\s*ray/gi },
  { canonical: "Profibus", pattern: /profi\s*bus/gi },
  { canonical: "LoRaWAN", pattern: /lora\s*wan/gi },
  { canonical: "LoRa", pattern: /\blora\b/gi },
  { canonical: "NB-IoT", pattern: /n\s*b\s*[- ]?\s*i\s*o\s*t/gi },
  { canonical: "Zigbee", pattern: /zig\s*bee/gi },
  { canonical: "NFC", pattern: /\bn\s*f\s*c\b/gi },
  { canonical: "MQTT", pattern: /m\s*q\s*t\s*t/gi },
  { canonical: "Modbus", pattern: /m\s*o\s*d\s*b\s*u\s*s/gi },
  { canonical: "LwIP", pattern: /l\s*w\s*i\s*p/gi },
  { canonical: "CoAP", pattern: /c\s*o\s*a\s*p/gi },
  { canonical: "DHCP", pattern: /d\s*h\s*c\s*p/gi },
  { canonical: "DNS", pattern: /\bd\s*n\s*s\b/gi },
  { canonical: "SNTP", pattern: /s\s*n\s*t\s*p/gi },
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
  ,{ canonical: "DTS", pattern: /\bd\s*t\s*s\b/gi }
  ,{ canonical: "DTB", pattern: /\bd\s*t\s*b\b/gi }
  ,{ canonical: "Rootfs", pattern: /root\s*f\s*s/gi }
  ,{ canonical: "Cgroups", pattern: /c\s*groups/gi }
  ,{ canonical: "Namespaces", pattern: /name\s*spaces/gi }
  ,{ canonical: "LittleFS", pattern: /little\s*f\s*s/gi }
  ,{ canonical: "SPIFFS", pattern: /s\s*p\s*i\s*f\s*f\s*s/gi }
  ,{ canonical: "eMMC", pattern: /e\s*m\s*m\s*c/gi }
  ,{ canonical: "LVGL", pattern: /l\s*v\s*g\s*l/gi }
  ,{ canonical: "V4L2", pattern: /v\s*4\s*l\s*2/gi }
  ,{ canonical: "ALSA", pattern: /a\s*l\s*s\s*a/gi }
  ,{ canonical: "TrustZone", pattern: /trust\s*zone/gi }
  ,{ canonical: "OP-TEE", pattern: /op\s*[- ]?\s*tee/gi }
  ,{ canonical: "mbedTLS", pattern: /m\s*bed\s*tls/gi }
  ,{ canonical: "AUTOSAR", pattern: /auto\s*sar/gi }
  ,{ canonical: "ISO 26262", pattern: /iso\s*26262/gi }
  ,{ canonical: "MISRA C", pattern: /misra\s*c/gi }
  ,{ canonical: "SOME/IP", pattern: /some\s*[\/]?\s*i\s*p/gi }
  ,{ canonical: "State Machine", pattern: /state\s*machine/gi }
  ,{ canonical: "Callback", pattern: /call\s*back/gi }
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
  for (const rule of [...rules].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    normalized = normalized.replace(rule.pattern, (raw) => {
      if (rule.context) {
        const flags = rule.context.flags.replace(/g/g, "");
        if (!new RegExp(rule.context.source, flags).test(normalized)) return raw;
      }
      if (raw !== rule.canonical) corrections.push({
        raw,
        canonical: rule.canonical,
        source,
        confidence: (rule.priority ?? 0) >= 100 ? 0.99 : source === "embedded" ? 0.96 : source === "project" ? 0.95 : 0.9,
        reason: rule.context ? "contextual-rule" : "terminology-rule"
      });
      return rule.canonical;
    });
  }
  return normalized;
}

export function normalizeTechnicalTermsWithCorrections(text: string, projectRules: readonly TerminologyRule[] = []): { text: string; corrections: TerminologyCorrection[] } {
  const corrections: TerminologyCorrection[] = [];
  let normalized = text.replace(/\s+/g, " ").trim();
  normalized = applyRules(normalized, projectRules, "project", corrections);
  normalized = applyRules(normalized, EMBEDDED_TERMINOLOGY_RULES, "embedded", corrections);
  normalized = applyRules(normalized, INTERVIEW_TERMINOLOGY_RULES, "general", corrections);
  return { text: normalized, corrections };
}

export interface ContextualTerminologyOptions {
  contextText?: string;
  entities?: readonly string[];
  topics?: readonly string[];
}

/**
 * Resolve ASR homophones whose meaning cannot be inferred safely in isolation.
 * In particular, “约函数/余函数” is only rewritten when nearby speech clearly
 * establishes a C++/OOP/polymorphism context.
 */
export function resolveContextualTerminology(text: string, options: ContextualTerminologyOptions = {}): { text: string; corrections: TerminologyCorrection[] } {
  const base = normalizeTechnicalTermsWithCorrections(text);
  const context = [options.contextText, ...(options.entities ?? []), ...(options.topics ?? [])].filter(Boolean).join(" ");
  const cppContext = /C\+\+|面向对象|多态|继承|虚函数|override|virtual|类|对象/i.test(context);
  if (!cppContext || !/(?:约|余)\s*函数/.test(base.text)) return base;
  const corrections = [...base.corrections];
  const resolved = base.text.replace(/(?:约|余)\s*函数/g, (raw) => {
    corrections.push({ raw, canonical: "虚函数", source: "embedded", confidence: 0.97, reason: "cpp-oop-context", context: "C++/OOP/polymorphism" });
    return "虚函数";
  });
  return { text: resolved, corrections };
}

export function normalizeTechnicalTerms(text: string): string {
  return normalizeTechnicalTermsWithCorrections(text).text;
}

/**
 * Canonical key for matching a project fact to an existing Profile skill.
 * This intentionally only collapses true aliases; related concepts such as
 * FOC and PID remain different skills.
 */
export function normalizeSkillKey(value: string): string {
  const normalized = normalizeTechnicalTerms(value).trim().toLowerCase().replace(/[\s._-]+/g, "");
  if (/^stm32(?:f|g)?\d/.test(normalized) || normalized === "stm32") return "stm32";
  if (/^(?:freertos|rtos)$/.test(normalized)) return "rtos";
  if (/^(?:c\+\+|cpp|cxx)$/.test(normalized)) return "cpp";
  if (/^(?:can|fdcan|socketcan)$/.test(normalized)) return "can";
  if (/^(?:uart|usart)$/.test(normalized)) return "uart";
  if (/^(?:i2c|iic)$/.test(normalized)) return "i2c";
  if (/^modbus(?:rtu)?$/.test(normalized)) return "modbus";
  return normalized;
}

export function createTerminologyDictionary(initialRules: readonly TerminologyRule[] = []): TerminologyDictionary {
  const rules = [...initialRules];
  return {
    get rules() { return rules; },
    add(rule) { rules.push(rule); },
    addMany(nextRules) { rules.push(...nextRules); }
  };
}
