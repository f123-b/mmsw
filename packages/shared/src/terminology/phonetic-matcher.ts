import { compactTerminologyToken, normalizeTerminologyToken } from "./token-normalizer";

export function levenshteinDistance(left: string, right: string): number {
  const a = compactTerminologyToken(left);
  const b = compactTerminologyToken(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

export function similarity(left: string, right: string): number {
  const a = compactTerminologyToken(left);
  const b = compactTerminologyToken(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
}

export function phoneticAliasMatch(value: string, aliases: readonly string[]): { alias: string; score: number } | undefined {
  const normalized = normalizeTerminologyToken(value);
  let best: { alias: string; score: number } | undefined;
  for (const alias of aliases) {
    const target = normalizeTerminologyToken(alias);
    if (!target || !normalized.includes(target)) continue;
    const score = target.includes(" ") ? 0.96 : 0.94;
    if (!best || score > best.score) best = { alias, score };
  }
  return best;
}
