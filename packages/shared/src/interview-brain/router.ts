import type { AnswerTask } from "./types";

export function routeAnswerTask(input: { question: string; type: AnswerTask["type"]; topic?: string; context: string[] }): AnswerTask {
  const text = input.question;
  const mode = /架构|系统设计|重新设计|故障|定位|优化方案|优缺点|权衡|为什么这样设计/.test(text) ? "DEEP" : text.length <= 14 || /是什么|什么是|一句话/.test(text) ? "FAST" : "NORMAL";
  const context = [input.topic ? `当前主题：${input.topic}` : "", ...input.context].filter(Boolean).slice(-10);
  return { question: text, type: input.type, context, mode };
}

