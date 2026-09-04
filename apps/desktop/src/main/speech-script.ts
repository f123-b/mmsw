export interface SpeechScript {
  filename: string;
  mimeType: string;
  text: string;
  updatedAt: number;
}

export const SPEECH_SCRIPT_MAX_BYTES = 12 * 1024 * 1024;
export const SPEECH_SCRIPT_MAX_TEXT_LENGTH = 1_500_000;

export function normalizeSpeechScript(value: unknown): SpeechScript | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<SpeechScript>;
  if (typeof source.filename !== "string" || typeof source.mimeType !== "string" || typeof source.text !== "string" || typeof source.updatedAt !== "number") return undefined;
  const text = source.text.trim();
  if (!text || text.length > SPEECH_SCRIPT_MAX_TEXT_LENGTH) return undefined;
  return {
    filename: source.filename.trim() || "演讲稿",
    mimeType: source.mimeType.trim() || "text/plain",
    text,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : Date.now()
  };
}
