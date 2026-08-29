import { describe, expect, it } from "vitest";
import { TechnicalAccuracyGuard } from "./technical-accuracy-guard";

describe("technical accuracy guard", () => {
  const guard = new TechnicalAccuracyGuard();

  it("repairs the CAN arbitration misconception", () => {
    const result = guard.check({ question: "CAN 总线如何仲裁？", answer: "CAN 会抢占正在发送的报文。" });
    expect(result.decision).toBe("rewrite");
    expect(result.rewrittenAnswer).toContain("非破坏性的按位仲裁");
    expect(result.rewrittenAnswer).toContain("不会打断");
  });

  it.each([
    ["volatile 是什么？", "volatile 保证线程安全。", "不提供原子性"],
    ["ARM 指令都是 32 位吗？", "ARM 指令全部是 32 位。", "16 位和 32 位"],
    ["I2C 是什么？", "I2C 属于全双工。", "半双工"],
    ["TCP 有消息边界吗？", "TCP 保留消息边界。", "可靠字节流"]
  ] as const)("repairs %s", (question, answer, expected) => {
    expect(guard.check({ question, answer }).rewrittenAnswer).toContain(expected);
  });

  it("does not rewrite an explicitly correct negated statement", () => {
    const result = guard.check({ question: "CAN 总线如何仲裁？", answer: "CAN 不会打断正在发送的完整报文。" });
    expect(result.decision).toBe("allow");
  });

  it.each([
    ["++p 和 p++ 有什么区别？", "++p 先取值，p++ 先移动。", "前置自增"],
    ["PWM 中心对齐有什么好处？", "中心对齐 PWM 一定会多一次采样机会。", "不能绝对化"],
    ["FOC 为什么只采两相电流？", "两相采样必然少一次中断。", "ia、ib"],
    ["UDP 可靠吗？", "UDP 绝对不会重传。", "协议本身不提供"]
  ] as const)("repairs newly covered accuracy risk: %s", (question, answer, expected) => {
    const result = guard.check({ question, answer });
    expect(result.decision).toBe("rewrite");
    expect(result.rewrittenAnswer).toContain(expected);
    expect(result.violationCount).toBeGreaterThan(0);
  });
});
