import type { KnowledgeChunk } from '@interview-copilot/shared';

/** Binding to the selected project, not the filename/LLM confidence, grants
 * document scope. Generic manuals and a bare project title are not evidence. */
export function scopedProjectEvidence(projectId: string | undefined, chunks: KnowledgeChunk[], facts: string[] = []): string[] {
  if (!projectId) return [];
  return [...facts, ...chunks.filter(chunk => {
    const meta = chunk.metadata as unknown as Record<string, unknown>;
    return meta.projectId === projectId && meta.scope === 'project' && meta.relationship !== 'reference' && meta.sourceRole !== 'reference' && chunk.text.trim().length >= 20;
  }).map(chunk => `[PROJECT_SOURCE ${chunk.metadata.documentId}] ${chunk.metadata.filename}: ${chunk.text}`)].slice(0, 10);
}

export function projectResumeEvidence(evidence: string[], names: string[]): string[] {
  const terms = names.flatMap(name => [name.trim(), ...(name.match(/[A-Za-z][A-Za-z0-9+#-]{1,}/g) ?? [])]).filter(term => term.length >= 2);
  return evidence.filter(text => terms.some(term => text.toLowerCase().includes(term.toLowerCase()))).slice(0, 3);
}
