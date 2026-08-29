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
  source?: TerminologySource;
}

export type TerminologySource = "embedded" | "general" | "project" | "builtin" | "profile" | "question_bank" | "contextual" | "phonetic" | "llm";

export interface TerminologyCorrection {
  raw: string;
  canonical: string;
  source: TerminologySource;
  confidence?: number;
  reason?: string;
  context?: string;
}

export interface DynamicTechnicalLexiconEntry {
  term: string;
  canonical: string;
  source: "builtin" | "profile" | "project" | "question_bank" | "llm";
  confidence: number;
  aliases?: string[];
}

export interface DynamicTechnicalLexicon {
  readonly entries: readonly DynamicTechnicalLexiconEntry[];
  readonly rules: readonly TerminologyRule[];
}

export interface DynamicTechnicalLexiconInput {
  profileSkills?: readonly (string | { name?: string; aliases?: readonly string[]; content?: string })[];
  projectFacts?: readonly (string | { title?: string; content?: string; value?: unknown })[];
  projectQa?: readonly (string | { question?: string; answer?: string })[];
  generalQa?: readonly (string | { question?: string; answer?: string })[];
  resume?: string;
  jobDescription?: string;
  recentTopics?: readonly string[];
  entries?: readonly DynamicTechnicalLexiconEntry[];
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
  { canonical: "电流环", pattern: /电炉环/g, context: /FOC|电机|电流环|控制环/i, priority: 125, source: "contextual" },
  { canonical: "RTOS", pattern: /(?<!R)T\s*O\s*S/gi, context: /RTOS|FreeRTOS|任务|调度|实时/i, priority: 124, source: "contextual" },
  { canonical: "技术栈", pattern: /季度战/g, context: /项目|简历|自我介绍|技术|使用|负责|开发/i, priority: 124, source: "contextual" },
  { canonical: "帧头、长度", pattern: /针头长度/g, context: /协议|帧|报文|解析|字段/i, priority: 124, source: "contextual" },
  { canonical: "Bootloader", pattern: /Woodloader/gi, context: /固件|启动|引导|升级|烧录|Bootloader/i, priority: 124, source: "contextual" },
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

const TECHNICAL_LEXICON_TOKEN = /(?:[A-Z][A-Za-z0-9+#./-]{1,31}|[A-Za-z][A-Za-z0-9+#./-]{2,31}\d[A-Za-z0-9+#./-]*|[\u4e00-\u9fff]{2,12}(?:总线|协议|系统|控制|模块|算法|架构|文件系统|关键字|项目|网关|驱动|中断|采样|通信|数据库|线程))/g;

function sourceConfidence(source: TerminologySource, priority = 0): number {
  if (priority >= 100) return 0.99;
  if (source === "phonetic" || source === "contextual") return 0.97;
  if (source === "embedded" || source === "builtin") return 0.96;
  if (source === "project" || source === "profile") return 0.95;
  if (source === "question_bank") return 0.93;
  return 0.9;
}

function applyRules(text: string, rules: readonly TerminologyRule[], source: TerminologyCorrection["source"], corrections: TerminologyCorrection[], contextOverride?: string): string {
  let normalized = text;
  for (const rule of [...rules].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    normalized = normalized.replace(rule.pattern, (raw) => {
      if (rule.context) {
        const flags = rule.context.flags.replace(/g/g, "");
        if (!new RegExp(rule.context.source, flags).test(contextOverride ?? normalized)) return raw;
      }
      if (raw !== rule.canonical) corrections.push({
        raw,
        canonical: rule.canonical,
        source: rule.source ?? source,
        confidence: sourceConfidence(rule.source ?? source, rule.priority),
        reason: rule.context ? "contextual-rule" : "terminology-rule"
      });
      return rule.canonical;
    });
  }
  return normalized;
}

function inputText(value: string | { name?: string; aliases?: readonly string[]; content?: string; title?: string; value?: unknown; question?: string; answer?: string }): string {
  if (typeof value === "string") return value;
  return [value.name, ...(value.aliases ?? []), value.title, value.content, value.question, value.answer, typeof value.value === "string" ? value.value : undefined].filter(Boolean).join(" ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a conservative session lexicon. Only terms that look like a model,
 * protocol, acronym, or explicit technical phrase become rewrite rules; prose
 * words are deliberately ignored to avoid false corrections.
 */
export function buildDynamicTechnicalLexicon(input: DynamicTechnicalLexiconInput = {}): DynamicTechnicalLexicon {
  const entries: DynamicTechnicalLexiconEntry[] = [...(input.entries ?? [])];
  const sources: Array<[TerminologySource, readonly (string | Record<string, unknown>)[] | undefined]> = [
    ["profile", input.profileSkills],
    ["project", input.projectFacts],
    ["question_bank", input.projectQa],
    ["question_bank", input.generalQa],
    ["project", input.recentTopics],
    ["profile", [input.resume, input.jobDescription].filter((value): value is string => Boolean(value))]
  ];
  for (const [source, values] of sources) {
    for (const value of values ?? []) {
      if (typeof value !== "string") {
        const explicitTerm = typeof value.name === "string" ? value.name : typeof value.title === "string" ? value.title : undefined;
        if (explicitTerm && !entries.some((entry) => entry.term.toLowerCase() === explicitTerm.toLowerCase() && entry.source === source)) {
          entries.push({ term: explicitTerm, canonical: explicitTerm, source: source as DynamicTechnicalLexiconEntry["source"], confidence: source === "project" ? 0.96 : 0.92, ...(Array.isArray(value.aliases) && value.aliases.length ? { aliases: [...value.aliases] } : {}) });
        }
      }
      const text = inputText(value as Parameters<typeof inputText>[0]);
      for (const match of text.matchAll(TECHNICAL_LEXICON_TOKEN)) {
        const term = match[0].trim();
        if (term.length < 3 || /^(?:The|This|With|What|Study|Count|Project|System)$/i.test(term)) continue;
        if (!entries.some((entry) => entry.term.toLowerCase() === term.toLowerCase() && entry.source === source)) {
          entries.push({ term, canonical: term, source: source as DynamicTechnicalLexiconEntry["source"], confidence: source === "project" ? 0.96 : 0.92 });
        }
      }
    }
  }
  const rules = entries.flatMap((entry) => {
    const aliases = [entry.term, ...(entry.aliases ?? [])].filter((alias) => alias && alias !== entry.canonical);
    return aliases.map((alias) => ({ canonical: entry.canonical, pattern: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(alias)}(?![A-Za-z0-9])`, "gi"), priority: 30, source: entry.source } satisfies TerminologyRule));
  });
  return { entries, rules };
}

export interface TerminologyResolution {
  text: string;
  corrections: TerminologyCorrection[];
  rawText: string;
  normalizedText: string;
  canonicalText: string;
  confidence: number;
  possibleTerms: Array<{ value: string; score: number }>;
}

export function normalizeTechnicalTermsWithCorrections(text: string, projectRules: readonly TerminologyRule[] | DynamicTechnicalLexicon = []): { text: string; corrections: TerminologyCorrection[] } {
  const corrections: TerminologyCorrection[] = [];
  let normalized = text.replace(/\s+/g, " ").trim();
  const rules = "rules" in projectRules ? projectRules.rules : projectRules;
  normalized = applyRules(normalized, rules, "project", corrections);
  normalized = applyRules(normalized, EMBEDDED_TERMINOLOGY_RULES, "embedded", corrections);
  normalized = applyRules(normalized, INTERVIEW_TERMINOLOGY_RULES, "general", corrections);
  return { text: normalized, corrections };
}

export interface ContextualTerminologyOptions {
  contextText?: string;
  entities?: readonly string[];
  topics?: readonly string[];
  previousQuestion?: string;
  semanticFrame?: string;
  lexicon?: DynamicTechnicalLexicon;
}

/**
 * Resolve ASR homophones whose meaning cannot be inferred safely in isolation.
 * In particular, “约函数/余函数” is only rewritten when nearby speech clearly
 * establishes a C++/OOP/polymorphism context.
 */
export function resolveContextualTerminology(text: string, options: ContextualTerminologyOptions = {}): TerminologyResolution {
  const base = normalizeTechnicalTermsWithCorrections(text, options.lexicon ?? []);
  const context = [options.contextText, options.previousQuestion, options.semanticFrame, ...(options.entities ?? []), ...(options.topics ?? [])].filter(Boolean).join(" ");
  let resolved = base.text;
  const corrections = [...base.corrections];
  // Built-in contextual rules also need the surrounding interview context;
  // the plain normalizer intentionally only sees the current segment.
  resolved = applyRules(resolved, EMBEDDED_TERMINOLOGY_RULES.filter((rule) => Boolean(rule.context)), "contextual", corrections, context);
  resolved = resolved.replace(/\bRTOS\s*的\s*RTOS\b/giu, "RTOS 的");
  const add = (raw: string, canonical: string, reason: string, source: TerminologySource = "phonetic", confidence = 0.97): void => {
    if (raw === canonical) return;
    corrections.push({ raw, canonical, source, confidence, reason, context: context.slice(0, 160) });
  };
  const possibleTerms: Array<{ value: string; score: number }> = [];
  const cppContext = /C\+\+|面向对象|多态|继承|虚函数|override|virtual|类|对象/i.test(context);
  if (cppContext) resolved = resolved.replace(/(?:约|余)\s*函数/g, (raw) => { add(raw, "虚函数", "cpp-oop-context", "contextual"); return "虚函数"; });

  const explicitCContext = /C\+\+|C语言|C 语言|C\/C\+\+/i.test(context);
  const cSignalText = `${context} ${resolved}`;
  const cKeywordContext = /关键字|存储类|限定符|修饰符|常量/i.test(cSignalText) && /volatile|static|const|指针/i.test(cSignalText);
  const cContext = explicitCContext || cKeywordContext;
  if (cContext) {
    resolved = resolved.replace(/\bstudy\b/gi, (raw, offset: number, whole: string) => {
      const nearby = whole.slice(Math.max(0, offset - 24), offset + 36);
      if (/study\s*(?:计划|方法|习惯)|(?:计划|方法|习惯)\s*study/i.test(nearby)) return raw;
      add(raw, "static", "c-keyword-phonetic", "phonetic");
      return "static";
    });
    resolved = resolved.replace(/\bcount\b/gi, (raw, offset: number, whole: string) => {
      const nearby = whole.slice(Math.max(0, offset - 36), offset + 40);
      if (/count\s*(?:\+\+|--|\]|变量|字段|值)|[\[.]\s*count\b|\b(?:变量|字段)\s*count/i.test(nearby)) return raw;
      if (!/(?:关键字|限定符|修饰符|常量|作用|含义|声明|类型)/i.test(nearby)) return raw;
      add(raw, "const", "c-keyword-phonetic", "phonetic");
      return "const";
    });
  }
  if (!cContext && /\bstudy\b/i.test(resolved) && !/study\s*(?:计划|方法|习惯)/i.test(resolved)) possibleTerms.push({ value: "static", score: 0.64 }, { value: "study", score: 0.36 });
  if (!cContext && /\bcount\b/i.test(resolved) && !/count\s*(?:\+\+|--|\]|变量|字段|值)/i.test(resolved)) possibleTerms.push({ value: "const", score: 0.64 }, { value: "count", score: 0.36 });

  const motorContext = /FOC|电机|电机控制|编码器|电角度|机械角|转子|极对/i.test(context);
  if (motorContext) resolved = resolved.replace(/(?:一对数|绝对是|绝对数|极对术)/g, (raw) => { add(raw, "极对数", "motor-control-phonetic"); return "极对数"; });

  const stackContext = /堆|栈|内存|malloc|free|内存管理|溢出|heap|stack/i.test(context);
  if (stackContext) resolved = resolved.replace(/(?:这和站|和站)/g, (raw) => { add(raw, "栈", "stack-phonetic"); return "栈"; });

  const confidence = corrections.length ? Math.min(...corrections.map((correction) => correction.confidence ?? 0.9)) : 1;
  return { text: resolved, corrections, rawText: text, normalizedText: base.text, canonicalText: resolved, confidence: possibleTerms.length ? Math.min(confidence, 0.64) : confidence, possibleTerms };
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
