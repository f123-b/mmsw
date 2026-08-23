import type { ProjectMemoryAnalysisInput, ProjectMemoryModel, ProjectMemorySnapshot } from "./types";
import { ProjectMemoryAgent } from "./project-memory";

export interface ProjectAnalyzer {
  analyze(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot>;
}

export class ProjectAnalyzerAgent implements ProjectAnalyzer {
  private readonly agent: ProjectMemoryAgent;
  constructor(model?: ProjectMemoryModel) { this.agent = new ProjectMemoryAgent(model); }
  analyze(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot> { return this.agent.build(input); }
}

export interface CodeAnalysisResult {
  language: string;
  modules: Array<{ name: string; description: string; filePath: string }>;
  functions: Array<{ name: string; filePath: string; signature?: string }>;
  keywords: string[];
}

const CODE_KEYWORDS = ["FOC", "SVPWM", "PID", "DMA", "ADC", "PWM", "CAN", "UART", "MQTT", "FreeRTOS", "RTOS", "SQLite", "WebSocket", "OTA", "CMake", "线程", "任务", "状态机"];

export function analyzeCodeFile(input: { filePath: string; text: string; language?: string }): CodeAnalysisResult {
  const language = input.language ?? "unknown";
  const functions = [...input.text.matchAll(/(?:^|\n)\s*(?:static\s+)?(?:inline\s+)?[\w:*&<>\s]+\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g)].slice(0, 120).map((match) => ({ name: match[1] ?? "unknown", filePath: input.filePath }));
  const modules = input.filePath.split(/[\\/]/).filter(Boolean).slice(-1).map((name) => ({ name: name.replace(/\.[^.]+$/, ""), description: `源码文件 ${input.filePath} 的实现模块`, filePath: input.filePath }));
  const keywords = CODE_KEYWORDS.filter((keyword) => input.text.toLowerCase().includes(keyword.toLowerCase()));
  return { language, modules, functions, keywords };
}
