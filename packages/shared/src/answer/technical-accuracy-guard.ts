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
  { id: "volatile-not-thread-safe", question: /volatile|线程安全|并发/i, violation: /volatile[^。！？\n]{0,40}(?:保证|提供|就是)(?:线程安全|原子|同步)/i, negation: /volatile[^。！？\n]{0,40}(?:不|不能|不会)(?:保证|提供)(?:线程安全|原子|同步)/i, correction: "volatile 只约束编译器优化，不提供原子性、内存序或线程安全；并发访问仍需要原子类型或同步机制。" },
  { id: "static-not-atomic", question: /static/i, violation: /static[^。！？\n]{0,40}(?:保证|就是|表示)(?:原子|线程安全)/i, negation: /static[^。！？\n]{0,40}(?:不|不能|不会)(?:保证|表示)(?:原子|线程安全)/i, correction: "static 主要影响存储期或链接范围，不自动保证原子性和线程安全。" },
  { id: "arm-thumb-width", question: /ARM|Cortex-M|Thumb/i, violation: /(?:ARM|Cortex-M)[^。！？\n]{0,30}(?:指令|编码)?[^。！？\n]{0,12}(?:都是|全部是|固定为)\s*32\s*位/i, negation: /(?:不是|不一定|不能说)[^。！？\n]{0,20}32\s*位/i, correction: "不能笼统说 ARM 指令都是 32 位；Cortex-M 的 Thumb/Thumb-2 同时包含 16 位和 32 位编码。" },
  { id: "i2c-half-duplex", question: /IIC|I2C/i, violation: /(?:IIC|I2C)[^。！？\n]{0,30}(?:是|属于|支持)\s*全双工|全双工[^。！？\n]{0,20}(?:IIC|I2C)/i, negation: /(?:不是|不属于|不能算)[^。！？\n]{0,12}全双工/i, correction: "I2C 是半双工总线，共用 SDA 数据线，读写方向可以切换但不能独立同时传输两路数据。" },
  { id: "tcp-byte-stream", question: /TCP|粘包|拆包/i, violation: /TCP[^。！？\n]{0,50}(?:保留|保持|对应|保证)[^。！？\n]{0,12}(?:消息|报文)边界|TCP[^。！？\n]{0,30}(?:一次|每次)[^。！？\n]{0,12}(?:send|recv|发送|接收)/i, negation: /TCP[^。！？\n]{0,50}(?:不|不会|不能)[^。！？\n]{0,12}(?:保留|保证|对应)/i, correction: "TCP 是可靠字节流，不保留应用层消息边界；应用层需要用长度字段、分隔符或固定帧处理拆包和粘包。" }
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
