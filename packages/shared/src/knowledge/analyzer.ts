import type { ProjectComprehensionModel, ProjectComprehensionTrace, ProjectUnderstanding } from "../project-comprehension";
import { ProjectComprehensionAgent } from "../project-comprehension";
import type { ProjectMemoryAnalysisInput, ProjectMemoryModel, ProjectMemorySnapshot } from "./types";
import { ProjectMemoryAgent } from "./project-memory";

export interface ProjectAnalyzer {
  analyze(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot>;
}

export class ProjectAnalyzerAgent implements ProjectAnalyzer {
  private readonly agent: ProjectMemoryAgent;
  private readonly comprehensionModel?: ProjectComprehensionModel;
  private readonly comprehensionTrace?: ProjectComprehensionTrace;
  private readonly comprehensionEnabled: boolean;

  constructor(model?: ProjectMemoryModel, comprehensionModel?: ProjectComprehensionModel, comprehensionTrace?: ProjectComprehensionTrace, comprehensionEnabled = true) {
    this.agent = new ProjectMemoryAgent(model);
    this.comprehensionModel = comprehensionModel;
    this.comprehensionTrace = comprehensionTrace;
    this.comprehensionEnabled = comprehensionEnabled;
  }

  async analyze(input: ProjectMemoryAnalysisInput, options: { cachedUnderstanding?: ProjectUnderstanding; signal?: AbortSignal } = {}): Promise<ProjectMemorySnapshot> {
    let understanding: ProjectUnderstanding | undefined;
    if (this.comprehensionEnabled && input.sources.length > 0) {
      const projectId = input.projectId ?? `project-${(input.projectName ?? "unknown").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").slice(0, 50)}`;
      try {
        const result = await new ProjectComprehensionAgent({ model: this.comprehensionModel, trace: this.comprehensionTrace, signal: options.signal }).comprehend({ ...input, projectId, projectName: input.projectName ?? "待确认项目", signal: options.signal }, options.cachedUnderstanding);
        understanding = result.understanding;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.message === "PROJECT_ANALYSIS_CANCELLED")) throw error;
        this.comprehensionTrace?.("PROJECT_COMPREHENSION_FAILED", { projectId, stage: "agent", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const snapshot = await this.agent.build({ ...input, ...(options.signal ? { signal: options.signal } : {}) });
    return understanding ? { ...snapshot, understanding } : snapshot;
  }
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
