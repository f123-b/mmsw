import { DomainRouter, type DomainRouterInput } from "./domain-router";
import { builtinTermsForDomains } from "./lexicons/builtin";
import type { SessionTerminologyContext, TechnicalDomain, TechnicalTerm, TechnicalTermSource } from "./terminology-types";

export interface DynamicLexiconInput extends DomainRouterInput {
  profileTerms?: readonly string[];
  resumeTerms?: readonly string[];
  jobTerms?: readonly string[];
  projectTerms?: readonly string[];
  customTerms?: readonly TechnicalTerm[];
  recentTopics?: readonly string[];
  now?: number;
}

const EXPLICIT_TECHNICAL_TERM = /(?:[A-Z][A-Za-z0-9+#./-]{1,31}|[A-Za-z][A-Za-z0-9+#./-]{2,31}\d[A-Za-z0-9+#./-]*|\b(?:Java|Linux|Python|React|Redis|MySQL|Kafka|Docker)\b)/g;

function termId(source: TechnicalTermSource, canonical: string): string { return `${source}:${canonical.toLocaleLowerCase().replace(/[^a-z0-9]+/gi, "-")}`; }

function termsFromStrings(values: readonly string[] | undefined, source: TechnicalTermSource, domains: readonly TechnicalDomain[]): TechnicalTerm[] {
  const result = new Map<string, TechnicalTerm>();
  for (const value of values ?? []) {
    for (const candidate of value.match(EXPLICIT_TECHNICAL_TERM) ?? []) {
      if (candidate.length < 3) continue;
      const canonical = candidate.trim();
      const key = canonical.toLocaleLowerCase();
      if (!result.has(key)) result.set(key, { id: termId(source, canonical), canonical, aliases: [canonical], domains: [...domains], source, priority: source === "project" ? 100 : source === "user" ? 120 : 90 });
    }
  }
  return [...result.values()];
}

function mergeTerms(terms: readonly TechnicalTerm[]): TechnicalTerm[] {
  const byCanonical = new Map<string, TechnicalTerm>();
  for (const item of terms) {
    const key = item.canonical.toLocaleLowerCase();
    const previous = byCanonical.get(key);
    if (!previous || item.priority > previous.priority) byCanonical.set(key, { ...item, aliases: [...new Set(item.aliases)], domains: [...item.domains] });
    else {
      previous.aliases = [...new Set([...previous.aliases, ...item.aliases])];
      previous.domains = [...new Set([...previous.domains, ...item.domains])];
    }
  }
  return [...byCanonical.values()];
}

export class DynamicLexiconBuilder {
  constructor(private readonly router = new DomainRouter()) {}

  build(input: DynamicLexiconInput = {}): SessionTerminologyContext {
    const route = this.router.route(input);
    const domains = [...new Set([...route.primaryDomains, ...route.secondaryDomains])] as TechnicalDomain[];
    const terms = mergeTerms([
      ...builtinTermsForDomains(domains),
      ...termsFromStrings(input.profileTerms, "resume", ["resume", ...domains]),
      ...termsFromStrings(input.resumeTerms, "resume", ["resume", ...domains]),
      ...termsFromStrings(input.jobTerms, "job", ["job", ...domains]),
      ...termsFromStrings(input.projectTerms, "project", ["project", ...domains]),
      ...(input.customTerms ?? [])
    ]);
    const sourceCounts = { builtin: 0, resume: 0, job: 0, project: 0, user: 0, session: 0 } satisfies Record<TechnicalTermSource, number>;
    for (const item of terms) sourceCounts[item.source] += 1;
    return { terms, primaryDomains: route.primaryDomains, secondaryDomains: route.secondaryDomains, sourceCounts, builtAt: input.now ?? Date.now() };
  }
}

export function buildSessionTerminologyContext(input: DynamicLexiconInput = {}): SessionTerminologyContext {
  return new DynamicLexiconBuilder().build(input);
}
