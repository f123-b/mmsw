export interface StableInterviewPrefixInput {
  persona?: string;
  resume?: string;
  jobDescription?: string;
  candidateProfile?: string;
  projectIndex?: string;
  answerStyle?: string;
}

export interface StableInterviewPrefixLimits {
  resume?: number;
  jobDescription?: number;
  projectIndex?: number;
}

function clip(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

/** Builds the byte-stable, low-churn prefix shared by all answer requests. */
export function buildStableInterviewPrefix(input: StableInterviewPrefixInput, limits: StableInterviewPrefixLimits = {}): string {
  const sections = [
    ["Persona", input.persona],
    ["Resume", clip(input.resume, limits.resume ?? 6_000)],
    ["JD", clip(input.jobDescription, limits.jobDescription ?? 3_000)],
    ["Candidate Profile", input.candidateProfile],
    ["Project Index", clip(input.projectIndex, limits.projectIndex ?? 2_500)],
    ["Answer Style", input.answerStyle]
  ] as const;
  return sections.filter(([, value]) => Boolean(value?.trim())).map(([label, value]) => `【${label}】\n${value!.trim()}`).join("\n\n");
}

export class StableInterviewPrefix {
  private readonly value: string;
  constructor(input: StableInterviewPrefixInput, limits?: StableInterviewPrefixLimits) { this.value = buildStableInterviewPrefix(input, limits); }
  get text(): string { return this.value; }
}
