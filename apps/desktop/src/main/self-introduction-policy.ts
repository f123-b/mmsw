import type { ProfileSelfIntroductionRecord } from "./database";

/** A user-authored script is an explicit presentation choice, not an AI fact proposal. */
export function canUseSelfIntroduction(record: Pick<ProfileSelfIntroductionRecord, "text" | "source" | "approved" | "status"> | undefined): boolean {
  return Boolean(record?.text.trim() && (record.source !== "ai_generated" || record.approved));
}
