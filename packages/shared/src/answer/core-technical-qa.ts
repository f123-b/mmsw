import { normalizeTechnicalTerms } from "../terminology";
import type { QuestionSemanticFrame } from "../question/semantic-frame";

export interface CoreTechnicalQaCard {
  id: string;
  question: string;
  aliases: string[];
  category: "embedded" | "c" | "network" | "linux";
  semanticFrame: QuestionSemanticFrame;
  shortAnswer: string;
  normalAnswer: string;
  deepAnswer: string;
  verified: true;
  version: string;
  source: string;
}

export const VERIFIED_CORE_TECHNICAL_QA: readonly CoreTechnicalQaCard[] = [
  { id: "can-arbitration", question: "CAN 总线如何仲裁", aliases: ["CAN如何仲裁", "CAN 仲裁", "CAN 总线仲裁"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "CAN 是差分、多主总线，空闲时多个节点可竞争；它按报文 ID 做非破坏性逐位仲裁，显性位覆盖隐性位，低 ID 通常优先。", normalAnswer: "CAN 使用差分信号和多主访问。总线空闲时多个节点可以同时开始发送，仲裁阶段逐位比较总线电平；显性位 0 会覆盖隐性位 1，发送隐性位却读到显性位的节点退出，因此数值更小、优先级更高的 ID 胜出，但不会打断正在发送的完整报文。CAN 还带有 CRC、ACK、位监测和错误帧机制，常用于车载和工业控制。", deepAnswer: "CAN 通过差分物理层、总线回读和逐位非破坏性仲裁实现多主通信。仲裁字段通常是标识符及控制位，显性位优先于隐性位；失 arbitration 的节点停止发送并等待下一次总线空闲。错误检测与错误主动/被动、总线关闭状态共同提高了故障隔离能力，所以不能把它描述成高优先级帧抢占低优先级完整报文。", verified: true, version: "core-2026.08", source: "embedded-core-qa" },
  { id: "can-basics", question: "CAN 是什么", aliases: ["CAN是什么", "CAN总线是什么", "CAN总线特点"], category: "embedded", semanticFrame: "definition", shortAnswer: "CAN 是一种差分、多主、面向报文的总线，具有按 ID 仲裁和错误检测能力，常用于车载与工业控制。", normalAnswer: "CAN 采用差分物理层和多主访问，节点在总线空闲时竞争发送，报文通过标识符参与非破坏性仲裁。它提供 CRC、ACK、位监测和错误状态管理，适合抗干扰、分布式控制场景。", deepAnswer: "CAN 的协议层和物理层共同提供面向报文的广播通信。回答时要区分总线空闲竞争、逐位仲裁、错误检测、重发和总线关闭等机制，不能把 CAN 描述成带消息队列或能抢占完整帧的传输。", verified: true, version: "core-2026.08", source: "embedded-core-qa" },
  { id: "c-volatile", question: "volatile 的作用", aliases: ["volatile关键字", "volatile 是什么", "volatile作用"], category: "c", semanticFrame: "keyword", shortAnswer: "volatile 告诉编译器每次都从内存读取并按语义写回，适合硬件寄存器和异步修改变量；它不提供原子性或线程安全。", normalAnswer: "volatile 用来声明一个可能被硬件、中断或其他执行流异步改变的对象，编译器不能把对它的访问随意缓存或删除。但 volatile 不等于原子操作，也不提供互斥、内存序或线程安全；并发场景仍需要锁或原子类型。", deepAnswer: "volatile 约束的是编译器优化和可观察访问，不是 CPU 的并发同步协议。它适用于 MMIO、ISR 与主循环共享的状态等场景，但复合读改写仍可能被打断，跨核可见性和顺序也不能仅靠 volatile 保证。", verified: true, version: "core-2026.08", source: "c-language-core-qa" },
  { id: "c-static", question: "static 关键字作用", aliases: ["static作用", "static 变量", "static关键字"], category: "c", semanticFrame: "keyword", shortAnswer: "static 的含义取决于位置：函数内变量延长生命周期，文件作用域声明限制链接范围，文件内函数也只在本文件可见。", normalAnswer: "在函数内部，static 局部变量只初始化一次并保持到程序结束；在文件作用域，static 变量或函数具有内部链接，只能在当前源文件使用。它不自动保证原子性，也不等于线程安全。", deepAnswer: "static 同时影响存储期和链接属性。块作用域的 static 变量拥有静态存储期但块作用域可见；文件作用域的 static 对象或函数拥有内部链接。它与 const、volatile、线程同步是不同维度的语义，不能混为一谈。", verified: true, version: "core-2026.08", source: "c-language-core-qa" },
  { id: "arm-instruction-width", question: "ARM 指令是否都是 32 位", aliases: ["ARM指令长度", "ARM都是32位", "ARM指令都是32位吗", "Cortex-M 指令宽度"], category: "embedded", semanticFrame: "definition", shortAnswer: "不都是。Cortex-M 主要执行 Thumb/Thumb-2 指令，既有 16 位也有 32 位编码；ARM64 又是另一套指令集语境。", normalAnswer: "不能笼统说 ARM 指令都是 32 位。Cortex-M 使用 Thumb/Thumb-2，指令编码可以是 16 位或 32 位；传统 A32 指令通常是 32 位，而 AArch64 使用固定 32 位指令但寄存器和指令集语义不同。", deepAnswer: "回答时要先区分执行状态和架构：A32 通常采用 32 位 ARM 指令，T32，也就是 Thumb/Thumb-2，包含 16 位和 32 位编码，Cortex-M 以 T32 为主；AArch64 的指令编码固定 32 位，但不能因此推导 Cortex-M 的全部指令都是 32 位。", verified: true, version: "core-2026.08", source: "arm-core-qa" },
  { id: "i2c-duplex", question: "I2C 是全双工还是半双工", aliases: ["IIC全双工", "I2C 双工", "IIC 半双工"], category: "embedded", semanticFrame: "definition", shortAnswer: "I2C 是半双工总线，共用 SDA 数据线；同一时刻不会独立地同时发送和接收两路数据。", normalAnswer: "I2C 是半双工通信。主机和从机通过共享的 SDA 与 SCL 线交互，读写方向可以切换，但同一条数据线不能像全双工接口那样同时承载两个独立方向的数据。", deepAnswer: "I2C 使用开漏 SDA/SCL 和主从时序，数据方向由读写位及 ACK 阶段控制。它支持多主仲裁和时钟拉伸，但这些能力不改变共享数据线带来的半双工属性。", verified: true, version: "core-2026.08", source: "embedded-core-qa" },
  { id: "tcp-message-boundary", question: "TCP 是否保留消息边界", aliases: ["TCP消息边界", "TCP 一次一包", "TCP粘包"], category: "network", semanticFrame: "definition", shortAnswer: "TCP 是可靠字节流，不保留应用层消息边界；应用层需要自己设计长度、分隔符或固定帧。", normalAnswer: "TCP 提供有序、可靠的字节流，不保证一次 send 对应一次 recv，也不保留应用层消息边界。解决粘包和拆包要在应用层增加长度字段、分隔符或固定长度协议，并循环读取到完整帧。", deepAnswer: "TCP 的发送缓冲、拥塞控制、分段和接收调度都会改变读写边界，所以不能把 TCP 段或 send 调用当成业务消息。工程上通常用 length-prefix、delimiter 或固定头部加长度的 framing，并处理半包、超时和异常断开。", verified: true, version: "core-2026.08", source: "network-core-qa" },
  { id: "pwm-center-aligned", question: "PWM 中心对齐", aliases: ["中心对齐PWM", "PWM中心对齐有什么好处"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "中心对齐让计数器上下计数，脉冲相对周期中心对称，通常能降低特定谐波并改善采样时序。", normalAnswer: "中心对齐 PWM 使用向上、向下计数，比较匹配点在周期中心两侧对称出现。它有利于降低部分谐波，也方便把 ADC 采样安排在电压或电流较稳定的窗口，但频率和更新事件要按定时器模式重新计算。", deepAnswer: "中心对齐并不是简单把边沿平移到中间，而是改变计数序列和比较事件。工程上要同时检查有效占空比、更新点、死区、ADC 触发源和控制环采样频率，避免因沿用边沿对齐的周期公式导致时序错误。", verified: true, version: "core-2026.08", source: "motor-control-core-qa" },
  { id: "mcu-definition", question: "什么是 MCU", aliases: ["什么是单片机", "MCU 是什么", "单片机是什么"], category: "embedded", semanticFrame: "definition", shortAnswer: "MCU 是把 CPU、存储器和外设集成在一颗芯片上的微控制器，适合实时控制和设备级应用。", normalAnswer: "MCU，也就是微控制器，通常把处理器核、Flash、RAM、定时器、GPIO、ADC 和通信外设集成在一颗芯片里。它强调成本、功耗、实时响应和外设控制，不等同于功能更复杂的应用处理器。", deepAnswer: "MCU 的程序一般直接运行在片上存储器中，通过中断、定时器和 DMA 与外设协同。选型要看主频、Flash/RAM、外设、封装、功耗、实时性和生态，而不能只比较 CPU 主频。", verified: true, version: "core-2026.08", source: "mcu-core-qa" },
  { id: "rtos-basics", question: "RTOS 的核心机制", aliases: ["RTOS是什么", "FreeRTOS任务调度", "实时操作系统有什么特点"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "RTOS 通过任务、调度器、优先级和同步通信机制，在可预测的时间约束下管理并发执行。", normalAnswer: "RTOS 通常提供任务/线程、优先级调度、时间片、队列、信号量和互斥锁。它关注确定性和截止时间，但实时性还取决于中断、临界区、优先级反转处理和任务设计。", deepAnswer: "RTOS 调度器在就绪任务中选择可运行任务，抢占点可能是时钟节拍、阻塞唤醒或显式切换。工程上还要评估最坏响应时间、栈使用、锁竞争和优先级继承，不能把“用了 RTOS”直接等同于硬实时。", verified: true, version: "core-2026.08", source: "rtos-core-qa" },
  { id: "interrupt-lifecycle", question: "中断从触发到 ISR 的过程", aliases: ["中断完整流程", "中断处理流程", "ISR执行过程"], category: "embedded", semanticFrame: "process", shortAnswer: "中断源置位后，处理器保存必要现场、查询向量表、进入 ISR；ISR 清除原因并处理事件，最后恢复现场返回。", normalAnswer: "完整流程是：外设产生并挂起中断，NVIC 等控制器判断屏蔽和优先级，处理器保存现场并查向量表，进入 ISR；ISR 读取状态、清除中断源、完成最小处理或投递任务，随后执行异常返回恢复现场。", deepAnswer: "还要检查优先级抢占、尾链、临界区、缓存/内存可见性和清 pending 的顺序。ISR 不宜做长时间阻塞或复杂业务，常见设计是快速确认硬件事件，再通过队列、信号量或标志交给线程。", verified: true, version: "core-2026.08", source: "interrupt-core-qa" },
  { id: "dma-purpose", question: "DMA 的作用", aliases: ["DMA是什么", "DMA有什么用", "为什么使用DMA"], category: "embedded", semanticFrame: "definition", shortAnswer: "DMA 让外设与内存之间直接搬运数据，CPU 只负责配置、接收完成/错误通知，从而降低搬运开销。", normalAnswer: "DMA 控制器按配置在外设和内存之间搬运数据，适合 UART、SPI、ADC 等连续数据流。CPU 不必逐字节参与，但仍要处理缓冲区所有权、缓存一致性、半传输/完成和错误中断。", deepAnswer: "工程上通常用环形或双缓冲把采集和处理解耦，并明确源/目的地址递增、数据宽度、突发长度和触发请求。DMA 不会自动解决吞吐、缓存或并发同步问题。", verified: true, version: "core-2026.08", source: "dma-core-qa" },
  { id: "adc-basics", question: "ADC 的作用", aliases: ["ADC是什么", "模数转换器", "ADC采样原理"], category: "embedded", semanticFrame: "definition", shortAnswer: "ADC 把模拟电压按参考电压和分辨率量化成数字值，采样率、建立时间和噪声会影响结果。", normalAnswer: "ADC，也就是模数转换器，把输入模拟量采样并量化为数字码。要关注分辨率、参考电压、采样保持时间、输入阻抗、触发时序、噪声和校准，不能只看位数。", deepAnswer: "在控制系统里，ADC 触发点要和 PWM、放大器建立时间及控制环周期配合；多通道扫描还要评估通道切换后的采样时间和 DMA 缓冲布局。", verified: true, version: "core-2026.08", source: "adc-core-qa" },
  { id: "spi-basics", question: "SPI 的特点", aliases: ["SPI是什么", "SPI通信特点", "SPI和I2C区别"], category: "embedded", semanticFrame: "definition", shortAnswer: "SPI 是同步、主从式、通常全双工的串行接口，速度高、协议简单，但需要片选线且没有统一寻址。", normalAnswer: "SPI 使用 SCK、MOSI、MISO 和 CS 等信号，主机提供时钟，收发可以同时进行。它通常比 I2C 更简单更快，但每个从设备往往需要独立片选，线数和板级设计要综合考虑。", deepAnswer: "SPI 的 CPOL/CPHA 模式、位序、片选时序和最大时钟要匹配器件手册；总线本身通常不规定 ACK、寻址和错误恢复，可靠性需要由器件协议或上层补充。", verified: true, version: "core-2026.08", source: "spi-core-qa" },
  { id: "uart-basics", question: "UART 的特点", aliases: ["UART是什么", "串口通信特点", "UART和SPI区别"], category: "embedded", semanticFrame: "definition", shortAnswer: "UART 是异步串行通信，通常只需 TX 和 RX，靠双方约定波特率、数据位、校验位和停止位。", normalAnswer: "UART 不提供独立时钟，发送端和接收端按约定波特率采样起始位、数据位、可选校验位和停止位。它接线简单，适合点对点调试和控制，但要处理波特率误差、帧错误和缓冲溢出。", deepAnswer: "工程上常配合中断或 DMA 接收，并用环形缓冲和帧协议解决边界问题；UART 电平标准还要和 RS-232、RS-485 收发器区分。", verified: true, version: "core-2026.08", source: "uart-core-qa" },
  { id: "compile-link-process", question: "编译和链接的过程", aliases: ["编译链接流程", "编译器和链接器做什么", "程序如何生成可执行文件"], category: "c", semanticFrame: "process", shortAnswer: "源码通常经历预处理、编译、汇编生成目标文件，最后由链接器解析符号并布局生成可执行文件或固件。", normalAnswer: "预处理展开宏和头文件，编译器把源代码变成汇编，汇编器生成目标文件；链接器合并目标文件和库，解析符号、安排段地址并生成 ELF、bin 或其他产物。", deepAnswer: "排查链接错误时要看声明/定义、链接顺序、可见性和脚本；嵌入式还要检查启动文件、向量表、内存区域、重定位和各段是否超出芯片容量。", verified: true, version: "core-2026.08", source: "toolchain-core-qa" },
  { id: "memory-stack-heap", question: "堆和栈的区别", aliases: ["堆栈区别", "栈和堆有什么区别", "stack heap区别"], category: "c", semanticFrame: "comparison", shortAnswer: "栈通常由调用关系自动管理，速度快但空间有限；堆由程序动态申请释放，灵活但要承担碎片、泄漏和并发管理成本。", normalAnswer: "栈保存调用帧、局部变量等，分配释放跟随作用域或调用，越界会破坏控制流；堆用于动态生命周期对象，需要明确所有权和释放时机，可能产生碎片和泄漏。", deepAnswer: "嵌入式系统还要考虑栈深度、水位线、实时分配风险、内存池和 DMA 对齐。具体实现细节取决于 ABI、运行时和分配器，不能把“栈一定在低地址、堆一定在高地址”当成语言保证。", verified: true, version: "core-2026.08", source: "memory-core-qa" },
  { id: "process-thread", question: "进程和线程的区别", aliases: ["进程线程区别", "进程与线程", "线程和进程有什么不同"], category: "linux", semanticFrame: "comparison", shortAnswer: "进程拥有相对独立的地址空间和资源，线程共享进程资源但有自己的栈和执行状态；线程切换和通信通常更轻量，也更需要同步。", normalAnswer: "进程提供资源和地址空间隔离，崩溃影响边界通常更清晰；同一进程的线程共享代码、数据和文件描述符，但各自有栈、寄存器和调度状态。线程共享带来效率，也带来数据竞争和锁设计问题。", deepAnswer: "Linux 中线程也由 task 结构调度，隔离程度取决于创建时共享的资源。选择进程还是线程要结合故障隔离、通信成本、并发模型和实时性，不应只按创建开销决定。", verified: true, version: "core-2026.08", source: "process-thread-core-qa" },
  { id: "hardfault-debug", question: "HardFault 如何定位", aliases: ["HardFault排查", "硬fault怎么定位", "HardFault原因"], category: "embedded", semanticFrame: "troubleshooting", shortAnswer: "先保存并解析异常现场，再看 CFSR、HFSR、BFAR/MMFAR 和堆栈中的 PC/LR，结合反汇编定位触发指令。", normalAnswer: "定位 HardFault 要先确认异常栈帧和使用的 MSP/PSP，读取 SCB 的 CFSR、HFSR、BFAR、MMFAR 等寄存器，再根据 PC、LR、栈内容和 map 文件还原故障位置。常见原因有非法访问、栈溢出、未对齐和执行权限问题。", deepAnswer: "还要记录 fault 前的任务、异常优先级和寄存器，并避免 fault handler 自身再次故障。编译选项、优化级别、浮点上下文和 RTOS 的异常栈布局都会影响解析，调试工具和符号文件要保持一致。", verified: true, version: "core-2026.08", source: "arm-fault-core-qa" },
  { id: "watchdog-basics", question: "看门狗的作用", aliases: ["Watchdog是什么", "看门狗怎么用", "为什么使用看门狗"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "看门狗在软件未按时完成喂狗时复位或上报故障，用来把死循环、卡死等异常带回可恢复状态。", normalAnswer: "看门狗提供有限的故障恢复机制：系统正常运行时按要求刷新，超时就触发复位或中断。喂狗不能放在一个无条件运行的定时器里，而应由关键任务或健康监测确认系统真的工作正常。", deepAnswer: "要配置合理超时、复位原因记录、启动阶段策略和故障现场保留，并避免用看门狗掩盖优先级反转、死锁、栈溢出等根因。", verified: true, version: "core-2026.08", source: "reliability-core-qa" },
  { id: "linux-filesystem", question: "Linux 文件系统", aliases: ["Linux文件系统", "Linux文件系统有哪些"], category: "linux", semanticFrame: "enumeration", shortAnswer: "常见的 Linux 文件系统有 ext4、XFS、Btrfs、F2FS、UBIFS、SquashFS、tmpfs、procfs 和 sysfs。", normalAnswer: "常见的 Linux 文件系统有 ext4、XFS、Btrfs、F2FS、UBIFS、SquashFS、tmpfs、procfs 和 sysfs；其中 procfs、sysfs 是内核提供的虚拟文件系统。VFS 统一了它们的目录、inode、权限和读写接口，但不能把虚拟文件系统当成普通磁盘文件系统。", deepAnswer: "回答 Linux 文件系统有哪些时，先列举 ext4、XFS、Btrfs、F2FS、UBIFS、SquashFS、tmpfs、procfs 和 sysfs，再按块设备、闪存、只读镜像、内存盘和内核状态接口分类。用户态系统调用进入 VFS 后再分派到具体 superblock、inode、dentry 和 file 操作；选型还要结合一致性、快照、写放大、性能和运维约束。", verified: true, version: "core-2026.08", source: "linux-core-qa" }
];

export type CoreQaMatchLevel = "exact" | "strong" | "partial" | "none";

export interface CoreTechnicalQaMatch {
  card?: CoreTechnicalQaCard;
  level: CoreQaMatchLevel;
  score: number;
  reasons: string[];
  frame?: QuestionSemanticFrame;
  entity?: string;
  lexicalScore: number;
}

function compactCore(text: string): string {
  return normalizeTechnicalTerms(text).toLowerCase().replace(/[\s？?。！!，,、；;：:（）()]/g, "");
}

/** Conservative deterministic router: exact/strong matches are answerable. */
export function routeCoreTechnicalQa(text: string): CoreTechnicalQaMatch {
  const compact = compactCore(text);
  let best: CoreTechnicalQaMatch = { level: "none", score: 0, reasons: [], lexicalScore: 0 };
  for (const card of VERIFIED_CORE_TECHNICAL_QA) {
    const candidates = [card.question, ...card.aliases].map(compactCore);
    const exact = candidates.find((candidate) => compact === candidate || compact.includes(candidate));
    const entity = card.question.match(/[A-Z][A-Za-z0-9+/-]*|C\+\+|I2C|CAN|PWM|DMA|ADC|UART|RTOS|Linux|volatile|static/i)?.[0];
    const normalizedEntity = entity?.toLowerCase().replace(/\s/g, "");
    const entityAliases = entity === "I2C" ? ["i2c", "iic"] : normalizedEntity ? [normalizedEntity] : [];
    const entityHit = !entity || entityAliases.some((alias) => compact.includes(alias));
    const lexical = Math.max(...candidates.map((candidate) => {
      const terms = candidate.match(/[a-z0-9+#]+|[\u4e00-\u9fff]{2}/g) ?? [];
      return terms.length ? terms.filter((term) => compact.includes(term)).length / terms.length : 0;
    }));
    const score = exact && entityHit ? 1 : entityHit ? lexical : 0;
    const level: CoreQaMatchLevel = exact && entityHit ? "exact" : score >= 0.72 ? "strong" : score >= 0.48 ? "partial" : "none";
    if (score > best.score) best = { card, level, score, reasons: exact ? ["alias-exact"] : ["lexical-overlap"], frame: card.semanticFrame, entity, lexicalScore: lexical };
  }
  return best;
}

export function matchCoreTechnicalQa(text: string): CoreTechnicalQaCard | undefined {
  const result = routeCoreTechnicalQa(text);
  return result.card && (result.level === "exact" || result.level === "strong") ? result.card : undefined;
}
