import { phoneticAliasMatch, similarity } from "./phonetic-matcher";
import { normalizeTerminologyToken } from "./token-normalizer";
import type { TechnicalTerm, TerminologyCandidate } from "./terminology-types";

function candidateFor(term: TechnicalTerm, raw: string, score: number, reason: string): TerminologyCandidate {
  return { raw, canonical: term.canonical, confidence: Math.max(0, Math.min(0.999, score)), source: term.source, domains: [...term.domains], reason, termId: term.id };
}

function addBest(target: Map<string, TerminologyCandidate>, candidate: TerminologyCandidate): void {
  const key = `${candidate.raw.toLocaleLowerCase()}\n${candidate.canonical}`;
  const previous = target.get(key);
  if (!previous || candidate.confidence > previous.confidence) target.set(key, candidate);
}

/** Local candidate generation. It never mutates transcript text. */
export class CandidateGenerator {
  generate(text: string, terms: readonly TechnicalTerm[]): TerminologyCandidate[] {
    const normalizedText = normalizeTerminologyToken(text);
    const result = new Map<string, TerminologyCandidate>();
    for (const term of terms) {
      const aliases = [...term.aliases, ...(term.phoneticAliases ?? [])].filter(Boolean);
      for (const alias of aliases) {
        const normalizedAlias = normalizeTerminologyToken(alias);
        if (!normalizedAlias) continue;
        const index = normalizedText.indexOf(normalizedAlias);
        if (index >= 0) {
          const raw = text.slice(index, index + alias.length);
          const isPhonetic = term.phoneticAliases?.some((item) => normalizeTerminologyToken(item) === normalizedAlias);
          const score = term.priority >= 100 ? 0.995 : isPhonetic ? 0.95 : normalizedAlias.includes(" ") ? 0.985 : 0.975;
          addBest(result, candidateFor(term, raw || alias, score, isPhonetic ? "phonetic-alias" : normalizedAlias.includes(" ") ? "separated-token" : "exact-alias"));
        }
      }
      // Fuzzy matching is deliberately restricted to short ASCII-like tokens;
      // ordinary Chinese speech, names and company names must not be rewritten.
      for (const token of normalizedText.match(/[a-z][a-z0-9+#.-]{2,31}/gi) ?? []) {
        const aliases = [term.canonical, ...term.aliases].filter((alias) => /^[a-z][a-z0-9+#.-]{2,31}$/i.test(alias.trim()));
        for (const alias of aliases) {
          const score = similarity(token, alias);
          if (score >= 0.7 && score < 0.97) addBest(result, candidateFor(term, token, 0.54 + score * 0.28, "edit-distance"));
        }
      }
      const phonetic = phoneticAliasMatch(normalizedText, term.phoneticAliases ?? []);
      if (phonetic) addBest(result, candidateFor(term, phonetic.alias, phonetic.score, "phonetic-similarity"));
    }
    return [...result.values()].sort((left, right) => right.confidence - left.confidence || right.raw.length - left.raw.length);
  }
}
