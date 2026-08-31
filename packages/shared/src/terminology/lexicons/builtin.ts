import type { TechnicalTerm } from "../terminology-types";

const term = (canonical: string, domains: TechnicalTerm["domains"], aliases: string[] = [], phoneticAliases: string[] = [], priority = 80): TechnicalTerm => ({
  id: `builtin:${canonical.toLocaleLowerCase().replace(/[^a-z0-9]+/gi, "-")}`,
  canonical,
  aliases: [canonical, ...aliases],
  ...(phoneticAliases.length ? { phoneticAliases } : {}),
  domains,
  source: "builtin",
  priority
});

export const BUILTIN_TERMS: readonly TechnicalTerm[] = [
  term("I2C", ["embedded", "common_cs"], ["i2c", "iic", "i 2 c"], ["I two C", "I to C"], 110),
  term("SPI", ["embedded"], ["s p i"]),
  term("UART", ["embedded", "network"], ["u a r t"], ["U A R T"], 110),
  term("FreeRTOS", ["embedded"], ["free rtos"]),
  term("HardFault", ["embedded", "c_cpp"], ["hard fault"], ["哈 fault"], 105),
  term("Watchdog Reset", ["embedded"], ["watchdog reset", "watch dog reset"]),
  term("STM32", ["embedded", "fpga_ic"], ["stm 32"]),
  term("FOC", ["embedded"], ["f o c"]),
  term("SVPWM", ["embedded"], ["s v p w m"]),
  term("ADC", ["embedded"], ["a d c"]),
  term("PWM", ["embedded"], ["p w m"]),
  term("DMA", ["embedded", "common_cs"], ["d m a"]),
  term("Interrupt Priority", ["embedded", "common_cs"], ["interrupt priority"]),
  term("Task Priority", ["common_cs", "embedded"], ["task priority"]),
  term("Mutex", ["common_cs", "c_cpp", "java"], ["mutex"]),
  term("Semaphore", ["common_cs", "java"], ["semaphore"]),
  term("Priority Inheritance", ["common_cs", "embedded", "java"], ["priority inheritance"]),
  term("C", ["c_cpp"], ["c language"]),
  term("C++", ["c_cpp"], ["c plus plus", "cpp"]),
  term("STL", ["c_cpp", "algorithm"], ["s t l"]),
  term("Linux", ["linux"], ["linux"]),
  term("TCP/IP", ["network"], ["tcp ip", "tcp/ip"]),
  term("HTTP", ["network", "backend", "frontend"], ["h t t p"]),
  term("MQTT", ["network", "embedded"], ["m q t t"]),
  term("WebSocket", ["network", "backend", "frontend"], ["web socket"]),
  term("MySQL", ["database", "backend"], ["mysql"], ["my sequel"], 100),
  term("PostgreSQL", ["database", "backend"], ["postgres sql"]),
  term("Redis", ["database", "backend"], ["redis"]),
  term("Java", ["java", "backend"], ["java"]),
  term("JVM", ["java", "backend"], ["jvm"]),
  term("Spring Boot", ["java", "backend"], ["springboot", "spring boot"]),
  term("CountDownLatch", ["java", "backend"], ["countdown latch"], ["count down latch"], 105),
  term("CompletableFuture", ["java", "backend"], ["completable future"]),
  term("ThreadPoolExecutor", ["java", "backend"], ["thread pool executor"]),
  term("React", ["frontend"], ["react"]),
  term("TypeScript", ["frontend"], ["type script"]),
  term("Python", ["ai_cv", "backend"], ["python"]),
  term("PyTorch", ["ai_cv"], ["pytorch"], ["py torch"]),
  term("YOLO", ["ai_cv"], ["yolo"]),
  term("ONNX", ["ai_cv"], ["onnx"]),
  term("Transformer", ["ai_cv"], ["transformer"]),
  term("RAG", ["ai_cv", "backend"], ["rag"]),
  term("Verilog", ["fpga_ic"], ["verilog"]),
  term("SystemVerilog", ["fpga_ic"], ["system verilog"]),
  term("UVM", ["fpga_ic"], ["uvm"]),
  term("AXI", ["fpga_ic"], ["axi"]),
  term("RISC-V", ["fpga_ic"], ["risc v", "risc-v"]),
  term("Docker", ["devops"], ["docker"]),
  term("Kubernetes", ["devops"], ["kubernetes", "k8s"]),
  term("CI/CD", ["devops"], ["ci cd", "ci/cd"]),
  // These two are candidate targets for “lake”; no context or exact alias
  // may elevate the edit-distance match to an automatic correction.
  term("Lock", ["common_cs", "database"], ["lock"]),
  term("Leak", ["common_cs", "c_cpp"], ["leak"])
];

export function builtinTermsForDomains(domains: readonly string[]): TechnicalTerm[] {
  const active = new Set(domains);
  return BUILTIN_TERMS.filter((item) => item.domains.some((domain) => active.has(domain))).map((item) => ({ ...item, aliases: [...item.aliases], ...(item.phoneticAliases ? { phoneticAliases: [...item.phoneticAliases] } : {}), domains: [...item.domains] }));
}
