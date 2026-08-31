export interface SelfIntroductionIntent {
  matched: boolean;
  confidence: number;
  targetDurationSeconds?: number;
  language?: "zh-CN" | "en-US";
  focus?: "overview" | "projects" | "skills" | "experience";
  style?: "simple" | "conversational";
  hasAdditionalConstraint: boolean;
}

const SELF_INTRODUCTION_PATTERNS = [
  /自我介绍/, /介绍一下自己/, /介绍下自己/, /做个自我介绍/, /先说说你的基本情况/, /请你介绍一下自己/
];
const PROJECT_BOUNDARY = /项目|工程|FOC|DMA|工作内容|职责|岗位|技术方案|实现细节/i;

function durationSeconds(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(分钟|分|秒)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.round(value * (match[2].includes("秒") ? 1 : 60)) : undefined;
}

/**
 * A deliberately narrow, local-only detector. The boundary check is important:
 * project and technology prompts must continue through project/technical QA.
 */
export function detectSelfIntroductionIntent(text: string): SelfIntroductionIntent {
  const value = text.trim();
  const matched = SELF_INTRODUCTION_PATTERNS.some((pattern) => pattern.test(value)) && !PROJECT_BOUNDARY.test(value.replace(/自我介绍|介绍一下自己|介绍下自己|做个自我介绍/g, ""));
  if (!matched) return { matched: false, confidence: 0, hasAdditionalConstraint: false };
  const targetDurationSeconds = durationSeconds(value);
  const language = /英文|英语|English/i.test(value) ? "en-US" : /中文|汉语|普通话/.test(value) ? "zh-CN" : undefined;
  const focus = /项目|工程/.test(value) ? "projects" : /技能|技术/.test(value) ? "skills" : /经历|工作/.test(value) ? "experience" : "overview";
  const style = /简单|简短|不要太长|口语|自然/.test(value) ? (/口语|自然/.test(value) ? "conversational" : "simple") : undefined;
  return { matched: true, confidence: 0.99, ...(targetDurationSeconds ? { targetDurationSeconds } : {}), ...(language ? { language } : {}), ...(focus ? { focus } : {}), ...(style ? { style } : {}), hasAdditionalConstraint: Boolean(targetDurationSeconds || language || style || focus !== "overview") };
}

export const analyzeSelfIntroductionIntent = detectSelfIntroductionIntent;
export const isSelfIntroductionRequest = (text: string): boolean => detectSelfIntroductionIntent(text).matched;
