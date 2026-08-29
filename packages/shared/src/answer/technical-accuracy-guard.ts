import { normalizeTechnicalTerms } from "../terminology";

export type TechnicalAccuracyDecision = "allow" | "rewrite";

export interface TechnicalAccuracyGuardResult {
  decision: TechnicalAccuracyDecision;
  rewrittenAnswer?: string;
  issues: string[];
  violationCount: number;
}

interface AccuracyRule {
  id: string;
  question: RegExp;
  violation: RegExp;
  negation: RegExp;
  correction: string;
}

const RULES: readonly AccuracyRule[] = [
  { id: "can-non-destructive-arbitration", question: /CAN|仲裁/i, violation: /(?:CAN[^。！？\n]{0,80})?(?:抢占|打断)(?:正在发送(?:的)?|完整)?(?:报文|消息|帧)/i, negation: /(?:不能|不会|不是|并非)[^。！？\n]{0,12}(?:抢占|打断)/i, correction: "CAN 的仲裁是非破坏性的按位仲裁，显性位覆盖隐性位，低 ID 节点胜出，但不会打断正在发送的完整报文。" },
  { id: "can-uart-no-absolute-delivery", question: /CAN|UART|串口/i, violation: /CAN[^。！？\n]{0,80}(?:保证|一定|不会)[^。！？\n]{0,12}(?:不丢|丢失|可靠)|UART[^。！？\n]{0,80}(?:做不到|一定|必然)[^。！？\n]{0,12}(?:不丢|可靠|保证)/i, negation: /(?:不能|不保证|取决于|仍需)[^。！？\n]{0,20}(?:不丢|可靠|保证)/i, correction: "CAN 提供仲裁、错误检测、ACK 和错误处理/重发等机制，但是否丢帧仍取决于总线状态、控制器状态和应用层超时恢复；UART 是点对点异步串口，是否丢包取决于拓扑、缓冲、流控和协议设计。" },
  { id: "uart-asynchronous-clock", question: /UART|串口|异步串行/i, violation: /(?:UART|串口)[^。！？\n]{0,35}(?:是|属于|使用)同步(?:通信|串行)|(?:发送端|接收端)[^。！？\n]{0,18}(?:提供|输出)独立时钟/i, negation: /(?:UART|串口)[^。！？\n]{0,35}(?:不是|不属于|无需)同步/i, correction: "UART 是异步串行通信，双方约定波特率、数据位、校验位和停止位，不使用独立的传输时钟线。" },
  { id: "dma-still-needs-ownership", question: /DMA|直接内存访问/i, violation: /DMA[^。！？\n]{0,45}(?:不占用|不需要|无需|完全不需要)[^。！？\n]{0,8}(?:CPU|配置|同步|缓存)/i, negation: /DMA[^。！？\n]{0,45}(?:仍然|依然|需要)(?:CPU|配置|同步|缓存)/i, correction: "DMA 减少 CPU 搬运数据的开销，但仍需要 CPU 配置传输，并处理缓冲区所有权、完成/错误通知和缓存一致性。" },
  { id: "watchdog-health-check", question: /看门狗|watchdog/i, violation: /无条件[^。！？\n]{0,20}喂狗[^。！？\n]{0,25}(?:就能|可以)保证(?:系统|程序)[^。！？\n]{0,12}(?:正常|健康)/i, negation: /(?:不能|不应该|不能只靠)[^。！？\n]{0,12}(?:无条件)?喂狗/i, correction: "看门狗只能提供超时复位兜底；喂狗应由健康监测确认关键任务正常运行，不能放在无条件执行的定时器里。" },
  { id: "isr-no-blocking-mutex", question: /ISR|中断|互斥锁|mutex/i, violation: /(?:ISR|中断)[^。！？\n]{0,35}(?:可以|应该|直接)[^。！？\n]{0,12}(?:等待|获取|持有)[^。！？\n]{0,12}(?:互斥锁|mutex)/i, negation: /(?:ISR|中断)[^。！？\n]{0,35}(?:不能|不应|不要)[^。！？\n]{0,12}(?:等待|获取|持有)[^。！？\n]{0,12}(?:互斥锁|mutex)/i, correction: "ISR 中不应阻塞等待互斥锁；中断处理应尽量短，只确认硬件状态并投递事件，复杂工作交给线程，再用合适的同步机制保护共享数据。" },
  { id: "volatile-not-thread-safe", question: /volatile|线程安全|并发/i, violation: /volatile[^。！？\n]{0,40}(?:保证|提供|就是)(?:线程安全|原子|同步)/i, negation: /volatile[^。！？\n]{0,40}(?:不|不能|不会)(?:保证|提供)(?:线程安全|原子|同步)/i, correction: "volatile 只约束编译器优化，不提供原子性、内存序或线程安全；并发访问仍需要原子类型或同步机制。" },
  { id: "static-not-atomic", question: /static/i, violation: /static[^。！？\n]{0,40}(?:保证|就是|表示)(?:原子|线程安全)/i, negation: /static[^。！？\n]{0,40}(?:不|不能|不会)(?:保证|表示)(?:原子|线程安全)/i, correction: "static 主要影响存储期或链接范围，不自动保证原子性和线程安全。" },
  { id: "arm-thumb-width", question: /ARM|Cortex-M|Thumb/i, violation: /(?:ARM|Cortex-M)[^。！？\n]{0,30}(?:指令|编码)?[^。！？\n]{0,12}(?:都是|全部是|固定为)\s*32\s*位/i, negation: /(?:不是|不一定|不能说)[^。！？\n]{0,20}32\s*位/i, correction: "不能笼统说 ARM 指令都是 32 位；Cortex-M 的 Thumb/Thumb-2 同时包含 16 位和 32 位编码。" },
  { id: "i2c-half-duplex", question: /IIC|I2C/i, violation: /(?:IIC|I2C)[^。！？\n]{0,30}(?:是|属于|支持)\s*全双工|全双工[^。！？\n]{0,20}(?:IIC|I2C)/i, negation: /(?:不是|不属于|不能算)[^。！？\n]{0,12}全双工/i, correction: "I2C 是半双工总线，共用 SDA 数据线，读写方向可以切换但不能独立同时传输两路数据。" },
  { id: "tcp-byte-stream", question: /TCP|粘包|拆包/i, violation: /TCP[^。！？\n]{0,50}(?:保留|保持|对应|保证)[^。！？\n]{0,12}(?:消息|报文)边界|TCP[^。！？\n]{0,30}(?:一次|每次)[^。！？\n]{0,12}(?:send|recv|发送|接收)/i, negation: /TCP[^。！？\n]{0,50}(?:不|不会|不能)[^。！？\n]{0,12}(?:保留|保证|对应)/i, correction: "TCP 是可靠字节流，不保留应用层消息边界；应用层需要用长度字段、分隔符或固定帧处理拆包和粘包。" },
  { id: "increment-prefix-postfix", question: /\+\+p|p\+\+|自增|指针/i, violation: /(?:\+\+p\s*(?:和|与|就是|等于)\s*p\+\+|\+\+p\s*(?:先|后)\s*取值|p\+\+\s*(?:先|后)\s*移动)/i, negation: /(?:区别|不同|前置|后置|先自增后取值|先取值后自增)/i, correction: "++p 是前置自增，先让 p 指向下一个元素再取值；p++ 是后置自增，先使用当前指向再移动，二者不能混为一谈。" },
  { id: "pwm-sampling-opportunity", question: /PWM|中心对齐|采样/i, violation: /(?:中心对齐|PWM)[^。！？\n]{0,50}(?:必然|一定|肯定|多一次|增加一次)[^。！？\n]{0,18}(?:采样|采样机会)/i, negation: /(?:不一定|并非|不能保证|通常|有利于|可能)/i, correction: "中心对齐 PWM 通常能提供更对称、更稳定的采样窗口，但是否多一次采样机会取决于定时器触发点、ADC 配置和控制环设计，不能绝对化。" },
  { id: "two-phase-current-sampling", question: /两相采样|电流采样|FOC|三相电流/i, violation: /(?:两相采样|采两相|由两相)[^。！？\n]{0,50}(?:必然|一定|肯定|少一次|减少一次)[^。！？\n]{0,18}(?:中断|ADC|采样)/i, negation: /(?:不一定|并非|不能保证|根据|取决于)/i, correction: "两相电流采样可用 ia、ib 推导 ic=-(ia+ib)，通常减少一个 ADC 通道或采样资源，但不保证必然少一次中断；中断次数由 PWM/ADC 触发策略决定。" },
  { id: "udp-no-absolute-retransmission", question: /UDP|可靠传输|重传/i, violation: /UDP[^。！？\n]{0,45}(?:绝对|一定|肯定|保证)[^。！？\n]{0,12}(?:不会|没有|不)[^。！？\n]{0,8}重传|UDP[^。！？\n]{0,25}(?:不会|不支持)[^。！？\n]{0,8}重传/i, negation: /(?:协议本身|自身)[^。！？\n]{0,12}(?:不提供|没有)[^。！？\n]{0,8}可靠重传/i, correction: "UDP 协议本身不提供可靠传输和重传机制；应用如果需要可靠性，要在上层自行设计序号、确认、超时和重传。" }
];

function replaceSentence(answer: string, correction: string, violation: RegExp): string {
  const sentences = answer.split(/(?<=[。！？!?；;\n])/u);
  let changed = false;
  const next = sentences.map((sentence) => {
    if (!violation.test(sentence)) return sentence;
    changed = true;
    return correction;
  });
  return changed ? next.join("") : answer;
}

export class TechnicalAccuracyGuard {
  check(input: { question: string; answer: string }): TechnicalAccuracyGuardResult {
    const question = normalizeTechnicalTerms(input.question);
    let rewritten = input.answer;
    const issues: string[] = [];
    for (const rule of RULES) {
      if (!rule.question.test(question)) continue;
      const candidate = rewritten.split(/(?<=[。！？!?；;\n])/u).find((sentence) => rule.violation.test(sentence) && !rule.negation.test(sentence));
      if (!candidate) continue;
      const next = replaceSentence(rewritten, rule.correction, rule.violation);
      if (next !== rewritten) {
        rewritten = next;
        issues.push(rule.id);
      }
    }
    return issues.length ? { decision: "rewrite", rewrittenAnswer: rewritten, issues, violationCount: issues.length } : { decision: "allow", issues: [], violationCount: 0 };
  }
}
