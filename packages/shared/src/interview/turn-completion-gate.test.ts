import { describe, expect, it } from "vitest";
import { TurnCompletionGate } from "./turn-completion-gate";

describe("TurnCompletionGate", () => {
  const gate = new TurnCompletionGate();

  it.each([
    "如果通信任务持有互斥锁。",
    "在你的嵌入式项目中，如果系统出现偶发死机。",
    "网络断开或设备重启。"
  ])("keeps semantic setup clauses open: %s", (text) => {
    expect(gate.decide(text).state).toBe("incomplete");
    expect(gate.decide(text).recommendedWaitMs).toBeGreaterThanOrEqual(800);
  });

  it("recognizes complete questions and non-question modifiers", () => {
    expect(gate.decide("DMA 的作用是什么？").state).toBe("complete");
    expect(gate.decide("下面聊一下 RTOS").state).toBe("topic_announcement");
    expect(gate.decide("请重点讲一下异常恢复").state).toBe("instruction_modifier");
  });
});
