import type { ProjectSourceRole } from "./types";

/**
 * Deterministic role inference for project material. The renderer may use it
 * for preview, but the main-process import path also runs it after parsing so
 * the persisted assignment never depends on UI state.
 */
export function inferProjectSourceRole(filename: string, optionalContent = ""): ProjectSourceRole {
  const basename = filename.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const stem = basename.replace(/\.[^.]+$/, "");
  const normalizedStem = stem.replace(/[\s_-]+/g, "");
  const content = optionalContent.toLowerCase();

  if (/(?:question|qa|q&a|interview[-_ ]?(?:questions?|qa|bank)|题库|面试题|标准答案|问答)/i.test(stem)) return "question_bank";

  const exact = new Map<string, ProjectSourceRole>([
    ["projectoverview", "overview"],
    ["readme", "overview"],
    ["projectsummary", "overview"],
    ["overview", "overview"],
    ["projectarchitecture", "architecture"],
    ["architecture", "architecture"],
    ["design", "architecture"],
    ["systemdesign", "architecture"],
    ["projecttechnicaldetails", "architecture"],
    ["technicaldetails", "architecture"],
    ["projectdebug", "debug"],
    ["debug", "debug"],
    ["debuglog", "debug"],
    ["bugfix", "debug"],
    ["troubleshooting", "debug"],
    ["retrospective", "debug"],
    ["projectresults", "test"],
    ["results", "test"],
    ["testreport", "test"],
    ["testresults", "test"],
    ["benchmark", "test"],
    ["performance", "test"]
  ]);
  const exactRole = exact.get(normalizedStem);
  if (exactRole) return exactRole;

  if (/\.zip$/i.test(basename)) return "code";
  if (/(?:resume|cv|简历)/i.test(stem)) return "resume";
  if (/(?:responsibility|ownership|职责)/i.test(stem)) return "responsibility";
  if (/(?:reference|datasheet|manual|specification|spec|手册|数据手册)/i.test(stem)) return "reference";
  if (/(?:source|src|repo(?:sitory)?|code|firmware|源码)/i.test(stem)) return "code";
  if (/(?:debug|bug|troubleshoot|排查|故障|问题|复盘)/i.test(stem)) return "debug";
  if (/(?:test|result|benchmark|performance|测试|结果|性能)/i.test(stem)) return "test";
  if (/(?:architect|design|technical|技术|架构|设计)/i.test(stem)) return "architecture";
  if (/(?:overview|summary|project|readme|说明|介绍|概览)/i.test(stem)) return "overview";

  // Content inference is intentionally conservative. A random README-like
  // paragraph must not become project evidence without a clear document cue.
  if (/(?:^|\n)\s*#{0,6}\s*(?:问题排查|故障排查|调试记录|debug|troubleshooting)(?=\s|$)/im.test(content)) return "debug";
  if (/(?:^|\n)\s*#{0,6}\s*(?:测试结果|测试报告|性能指标|benchmark|test results?)(?=\s|$)/im.test(content)) return "test";
  if (/(?:^|\n)\s*#{0,6}\s*(?:系统架构|架构设计|技术设计|system design|architecture)(?=\s|$)/im.test(content)) return "architecture";
  if (/(?:^|\n)\s*#{0,6}\s*(?:项目说明|项目概览|项目背景|project overview|summary)(?=\s|$)/im.test(content)) return "overview";
  if (/(?:^|\n)\s*#{0,6}\s*(?:项目题库|面试题库|question bank|interview questions|qa)(?=\s|$)/im.test(content)) return "question_bank";

  return "other";
}
