import type { ProjectComponent, ProjectRelationship, ProjectFlow } from "../../types";

/**
 * Domain vocabulary is intentionally isolated from the main builder. These
 * hints can suggest candidates for embedded-control projects, but they never
 * carry confirmation or relationship evidence by themselves.
 */
export const embeddedControlComponentHints: Array<Pick<ProjectComponent, "name" | "kind" | "description"> & { pattern: RegExp }> = [
  { name: "Motor Control", kind: "control", pattern: /\bfoc\b|motor|current loop|speed loop|svpwm|clarke|park|pi controller|电机|电流环|速度环/i, description: "负责控制算法、环路计算和执行量生成。" },
  { name: "Current Sampling", kind: "sampling", pattern: /\badc\d*\b|current sample|sampling|采样|电流采集/i, description: "负责把 ADC/传感器采样整理为控制环可用的数据。" },
  { name: "Encoder Feedback", kind: "feedback", pattern: /encoder|abz|position sensor|角度反馈|编码器/i, description: "提供位置或电角度反馈。" },
  { name: "Velocity Estimator", kind: "feedback", pattern: /velocity estimator|speed estimator|速度估算|转速估算/i, description: "根据反馈脉冲或位置变化估算速度。" },
  { name: "Protection", kind: "protection", pattern: /overcurrent|overvoltage|fault|protection|保护|过流|过压|故障/i, description: "负责故障检测、保护动作和安全停机。" },
  { name: "PWM Timer", kind: "driver", pattern: /\bpwm\b|timer trigger|定时器触发/i, description: "产生控制时序或外设触发事件。" },
];

export function embeddedControlFallbackRelationships(): Array<Pick<ProjectRelationship, "from" | "to" | "relation" | "description"> & { left: RegExp; right: RegExp }> {
  return [
    { from: "PWM Timer", to: "Current Sampling", relation: "triggers", description: "PWM 定时事件可能触发采样。", left: /pwm|timer|trgo/i, right: /adc|sampling|采样/i },
    { from: "Current Sampling", to: "Motor Control", relation: "feeds", description: "采样结果可能进入控制算法。", left: /adc|current|采样/i, right: /foc|current loop|电流环|svpwm/i },
    { from: "Encoder Feedback", to: "Velocity Estimator", relation: "feeds", description: "编码器反馈可能进入速度估算。", left: /encoder|abz|编码器/i, right: /velocity|speed|速度|转速/i },
  ];
}

export function embeddedControlFallbackFlows(): ProjectFlow[] { return []; }
