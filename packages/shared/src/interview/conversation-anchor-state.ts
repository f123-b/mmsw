import type { ActiveProjectContext, AnswerFrame, EntityAnchor, QuestionFrame, ReferenceCandidate } from "./question-frame";

export interface ConversationAnchorSnapshot {
  activeProject?: ActiveProjectContext;
  currentTopic?: { name: string; confidence: number; createdAt: number };
  activeComponent?: EntityAnchor;
  activeTechnology?: EntityAnchor;
  activeConcept?: EntityAnchor;
  lastQuestion?: QuestionFrame;
  lastAnswer?: AnswerFrame;
  unresolvedReferences: ReferenceCandidate[];
  entities: EntityAnchor[];
}

function cloneEntity(entity: EntityAnchor): EntityAnchor { return { ...entity }; }
function cloneQuestion(question?: QuestionFrame): QuestionFrame | undefined {
  return question ? { ...question, segmentIds: [...question.segmentIds], rawSegments: [...question.rawSegments], subQuestions: question.subQuestions.map((slot) => ({ ...slot })), entities: { ...question.entities, projects: [...question.entities.projects], components: [...question.entities.components], technologies: [...question.entities.technologies], concepts: [...question.entities.concepts] }, references: question.references.map((reference) => ({ ...reference, evidence: [...reference.evidence] })), confidence: { ...question.confidence }, unresolvedSlots: [...question.unresolvedSlots] } : undefined;
}

/** Structured conversation anchors used by V3 instead of passing raw transcript everywhere. */
export class ConversationAnchorState {
  private project?: ActiveProjectContext;
  private topic?: { name: string; confidence: number; createdAt: number };
  private component?: EntityAnchor;
  private technology?: EntityAnchor;
  private concept?: EntityAnchor;
  private question?: QuestionFrame;
  private answer?: AnswerFrame;
  private readonly entities: EntityAnchor[] = [];
  private readonly unresolvedReferences: ReferenceCandidate[] = [];

  reset(): void {
    this.project = undefined;
    this.topic = undefined;
    this.component = undefined;
    this.technology = undefined;
    this.concept = undefined;
    this.question = undefined;
    this.answer = undefined;
    this.entities.length = 0;
    this.unresolvedReferences.length = 0;
  }

  updateProject(project?: ActiveProjectContext): void { this.project = project ? { ...project, entities: [...project.entities], topics: [...project.topics] } : undefined; }
  updateTopic(name: string | undefined, confidence = 0.9, createdAt = Date.now()): void { if (name?.trim()) this.topic = { name: name.trim(), confidence, createdAt }; }
  updateQuestion(question: QuestionFrame): void { this.question = cloneQuestion(question); }
  updateAnswer(answer: AnswerFrame): void { this.answer = { ...answer }; }
  addReference(reference: ReferenceCandidate): void {
    const index = this.unresolvedReferences.findIndex((item) => item.raw === reference.raw);
    if (index >= 0) this.unresolvedReferences[index] = { ...reference, evidence: [...reference.evidence] };
    else this.unresolvedReferences.push({ ...reference, evidence: [...reference.evidence] });
    while (this.unresolvedReferences.length > 12) this.unresolvedReferences.shift();
  }
  resolveReference(raw: string, resolved: string): void {
    const reference = this.unresolvedReferences.find((item) => item.raw === raw);
    if (reference) { reference.resolved = resolved; reference.confidence = 1; }
  }
  addEntities(entities: EntityAnchor[]): void {
    for (const entity of entities) {
      const index = this.entities.findIndex((item) => item.value.toLowerCase() === entity.value.toLowerCase() && item.type === entity.type);
      if (index >= 0) this.entities.splice(index, 1);
      this.entities.push({ ...entity });
    }
    while (this.entities.length > 32) this.entities.shift();
    this.component = [...this.entities].reverse().find((item) => item.type === "component") ?? this.component;
    this.technology = [...this.entities].reverse().find((item) => item.type === "technology") ?? this.technology;
    this.concept = [...this.entities].reverse().find((item) => item.type === "concept") ?? this.concept;
  }

  snapshot(): ConversationAnchorSnapshot {
    return {
      ...(this.project ? { activeProject: { ...this.project, entities: [...this.project.entities], topics: [...this.project.topics] } } : {}),
      ...(this.topic ? { currentTopic: { ...this.topic } } : {}),
      ...(this.component ? { activeComponent: cloneEntity(this.component) } : {}),
      ...(this.technology ? { activeTechnology: cloneEntity(this.technology) } : {}),
      ...(this.concept ? { activeConcept: cloneEntity(this.concept) } : {}),
      ...(this.question ? { lastQuestion: cloneQuestion(this.question) } : {}),
      ...(this.answer ? { lastAnswer: { ...this.answer } } : {}),
      unresolvedReferences: this.unresolvedReferences.map((item) => ({ ...item, evidence: [...item.evidence] })),
      entities: this.entities.map(cloneEntity)
    };
  }
}
