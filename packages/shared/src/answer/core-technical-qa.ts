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
  { id: "can-arbitration", question: "CAN 总线如何仲裁", aliases: ["CAN如何仲裁", "CAN 仲裁", "CAN 总线仲裁"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "CAN 使用按位仲裁，显性位覆盖隐性位；发送低 ID 的节点优先，但不会破坏正在发送的报文。", normalAnswer: "CAN 的仲裁是非破坏性的按位仲裁。节点同时发送时，显性位 0 会覆盖隐性位 1；发送隐性位却读到显性位的节点立即退出，因此数值更小、优先级更高的 ID 胜出，获胜报文不需要重发。", deepAnswer: "CAN 通过开放集电极式总线和逐位回读实现非破坏性仲裁。仲裁字段通常是标识符及控制位，显性位优先于隐性位。节点在每一位发送后比较总线电平，失 arbitration 的节点停止发送并等待下一次总线空闲；所以优先级由 ID 决定，且不能把它描述成抢占正在发送的完整报文。", verified: true, version: "core-2026.08", source: "embedded-core-qa" },
  { id: "c-volatile", question: "volatile 的作用", aliases: ["volatile关键字", "volatile 是什么", "volatile作用"], category: "c", semanticFrame: "keyword", shortAnswer: "volatile 告诉编译器每次都从内存读取并按语义写回，适合硬件寄存器和异步修改变量；它不提供原子性或线程安全。", normalAnswer: "volatile 用来声明一个可能被硬件、中断或其他执行流异步改变的对象，编译器不能把对它的访问随意缓存或删除。但 volatile 不等于原子操作，也不提供互斥、内存序或线程安全；并发场景仍需要锁或原子类型。", deepAnswer: "volatile 约束的是编译器优化和可观察访问，不是 CPU 的并发同步协议。它适用于 MMIO、ISR 与主循环共享的状态等场景，但复合读改写仍可能被打断，跨核可见性和顺序也不能仅靠 volatile 保证。", verified: true, version: "core-2026.08", source: "c-language-core-qa" },
  { id: "c-static", question: "static 关键字作用", aliases: ["static作用", "static 变量", "static关键字"], category: "c", semanticFrame: "keyword", shortAnswer: "static 的含义取决于位置：函数内变量延长生命周期，文件作用域声明限制链接范围，文件内函数也只在本文件可见。", normalAnswer: "在函数内部，static 局部变量只初始化一次并保持到程序结束；在文件作用域，static 变量或函数具有内部链接，只能在当前源文件使用。它不自动保证原子性，也不等于线程安全。", deepAnswer: "static 同时影响存储期和链接属性。块作用域的 static 变量拥有静态存储期但块作用域可见；文件作用域的 static 对象或函数拥有内部链接。它与 const、volatile、线程同步是不同维度的语义，不能混为一谈。", verified: true, version: "core-2026.08", source: "c-language-core-qa" },
  { id: "arm-instruction-width", question: "ARM 指令是否都是 32 位", aliases: ["ARM指令长度", "ARM都是32位", "Cortex-M 指令宽度"], category: "embedded", semanticFrame: "definition", shortAnswer: "不都是。Cortex-M 主要执行 Thumb/Thumb-2 指令，既有 16 位也有 32 位编码；ARM64 又是另一套指令集语境。", normalAnswer: "不能笼统说 ARM 指令都是 32 位。Cortex-M 使用 Thumb/Thumb-2，指令编码可以是 16 位或 32 位；传统 A32 指令通常是 32 位，而 AArch64 使用固定 32 位指令但寄存器和指令集语义不同。", deepAnswer: "回答时要先区分执行状态和架构：A32 通常采用 32 位 ARM 指令，T32，也就是 Thumb/Thumb-2，包含 16 位和 32 位编码，Cortex-M 以 T32 为主；AArch64 的指令编码固定 32 位，但不能因此推导 Cortex-M 的全部指令都是 32 位。", verified: true, version: "core-2026.08", source: "arm-core-qa" },
  { id: "i2c-duplex", question: "I2C 是全双工还是半双工", aliases: ["IIC全双工", "I2C 双工", "IIC 半双工"], category: "embedded", semanticFrame: "definition", shortAnswer: "I2C 是半双工总线，共用 SDA 数据线；同一时刻不会独立地同时发送和接收两路数据。", normalAnswer: "I2C 是半双工通信。主机和从机通过共享的 SDA 与 SCL 线交互，读写方向可以切换，但同一条数据线不能像全双工接口那样同时承载两个独立方向的数据。", deepAnswer: "I2C 使用开漏 SDA/SCL 和主从时序，数据方向由读写位及 ACK 阶段控制。它支持多主仲裁和时钟拉伸，但这些能力不改变共享数据线带来的半双工属性。", verified: true, version: "core-2026.08", source: "embedded-core-qa" },
  { id: "tcp-message-boundary", question: "TCP 是否保留消息边界", aliases: ["TCP消息边界", "TCP 一次一包", "TCP粘包"], category: "network", semanticFrame: "definition", shortAnswer: "TCP 是可靠字节流，不保留应用层消息边界；应用层需要自己设计长度、分隔符或固定帧。", normalAnswer: "TCP 提供有序、可靠的字节流，不保证一次 send 对应一次 recv，也不保留应用层消息边界。解决粘包和拆包要在应用层增加长度字段、分隔符或固定长度协议，并循环读取到完整帧。", deepAnswer: "TCP 的发送缓冲、拥塞控制、分段和接收调度都会改变读写边界，所以不能把 TCP 段或 send 调用当成业务消息。工程上通常用 length-prefix、delimiter 或固定头部加长度的 framing，并处理半包、超时和异常断开。", verified: true, version: "core-2026.08", source: "network-core-qa" },
  { id: "pwm-center-aligned", question: "PWM 中心对齐", aliases: ["中心对齐PWM", "PWM中心对齐有什么好处"], category: "embedded", semanticFrame: "mechanism", shortAnswer: "中心对齐让计数器上下计数，脉冲相对周期中心对称，通常能降低特定谐波并改善采样时序。", normalAnswer: "中心对齐 PWM 使用向上、向下计数，比较匹配点在周期中心两侧对称出现。它有利于降低部分谐波，也方便把 ADC 采样安排在电压或电流较稳定的窗口，但频率和更新事件要按定时器模式重新计算。", deepAnswer: "中心对齐并不是简单把边沿平移到中间，而是改变计数序列和比较事件。工程上要同时检查有效占空比、更新点、死区、ADC 触发源和控制环采样频率，避免因沿用边沿对齐的周期公式导致时序错误。", verified: true, version: "core-2026.08", source: "motor-control-core-qa" },
  { id: "linux-filesystem", question: "Linux 文件系统", aliases: ["Linux文件系统", "Linux文件系统有哪些"], category: "linux", semanticFrame: "architecture", shortAnswer: "Linux 把文件、设备和很多内核对象统一成文件接口；常见文件系统包括 ext4、XFS、Btrfs，以及 procfs、sysfs 这类虚拟文件系统。", normalAnswer: "Linux 文件系统通过 VFS 统一不同文件系统的目录、inode、权限和读写接口。磁盘上常见 ext4、XFS、Btrfs；/proc 和 /sys 是内核提供的虚拟文件系统，用来观察进程与设备状态，不能把它们当普通磁盘文件系统。", deepAnswer: "用户态系统调用先进入 VFS，再分派到具体 superblock、inode、dentry 和 file 操作。选择 ext4、XFS 或 Btrfs 要结合一致性、快照、性能和运维约束；procfs/sysfs/debugfs 主要暴露内核状态，生命周期和持久化语义不同。", verified: true, version: "core-2026.08", source: "linux-core-qa" }
];

export function matchCoreTechnicalQa(text: string): CoreTechnicalQaCard | undefined {
  const normalized = normalizeTechnicalTerms(text).toLowerCase().replace(/[\s？?。！!，,、]/g, "");
  let best: { card: CoreTechnicalQaCard; score: number } | undefined;
  for (const card of VERIFIED_CORE_TECHNICAL_QA) {
    const candidates = [card.question, ...card.aliases].map((value) => normalizeTechnicalTerms(value).toLowerCase().replace(/[\s？?。！!，,、]/g, ""));
    const score = Math.max(...candidates.map((candidate) => normalized.includes(candidate) ? candidate.length / Math.max(1, normalized.length) + 0.6 : 0));
    if (score > (best?.score ?? 0)) best = { card, score };
  }
  return best && best.score >= 0.78 ? best.card : undefined;
}
