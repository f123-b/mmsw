import { LocalQuestionClassifier, type LocalQuestionModel, type LocalQuestionResult } from "./local-classifier";

export class SemanticQuestionAnalyzer {
  private readonly classifier: LocalQuestionModel;

  constructor(classifier?: LocalQuestionModel) {
    this.classifier = classifier ?? new LocalQuestionClassifier();
  }

  analyze(text: string, context: string[] = []): Promise<LocalQuestionResult> {
    return this.classifier.predict(text, context);
  }
}

