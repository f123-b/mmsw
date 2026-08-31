export function normalizeTerminologyToken(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”‘’]/g, "")
    .replace(/[，。！？、；：]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function terminologyTokens(value: string): string[] {
  return normalizeTerminologyToken(value).match(/[a-z0-9+#./-]+|[\u4e00-\u9fff]+/gi) ?? [];
}

export function compactTerminologyToken(value: string): string {
  return normalizeTerminologyToken(value).replace(/[^a-z0-9+#\u4e00-\u9fff]+/gi, "");
}
