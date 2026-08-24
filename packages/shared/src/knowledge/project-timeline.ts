export type ProjectTimelineStatus = "known" | "partial" | "unknown";

export interface ProjectTimelineValidation {
  status: ProjectTimelineStatus;
  value?: string;
  reason?: string;
}

const UNKNOWN_TIMELINE = /^(?:未知|未确认|未得到确认|待补充|未记录|无法确认|暂无|不详|unknown|n\/a)$/i;
const DATE = /(?:20\d{2}[年./-]\s*\d{1,2}(?:月|[./-]\s*\d{1,2})?|20\d{2}年?)/;
const RANGE = new RegExp(`${DATE.source}\\s*(?:至|到|~|～|\-|—)\\s*${DATE.source}`);
const DURATION = /(?:约\s*)?(?:\d+(?:\.\d+)?\s*(?:个?月|周|天)|半年|一年|两年|三年)/;

export function validateProjectTimeline(value: string | undefined): ProjectTimelineValidation {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized || UNKNOWN_TIMELINE.test(normalized)) return { status: "unknown", reason: "项目完整起止时间未确认" };
  if (RANGE.test(normalized)) return { status: "known", value: normalized };
  if (DURATION.test(normalized)) return { status: "partial", value: normalized };
  if (DATE.test(normalized) && !/(?:同步|周期|频率|采样|超时|延迟|us|ms|hz|kHz|计数)/i.test(normalized)) return { status: "partial", value: normalized };
  return { status: "unknown", reason: "内容不像项目时间，已拒绝写入项目时间字段" };
}

export function isUsableProjectTimeline(value: string | undefined): value is string {
  return validateProjectTimeline(value).status !== "unknown";
}
