import type { AnswerProvider } from "./answer";
import type { InterviewSnapshot } from "./history";

export interface PostInterviewAnalysis {
  technicalTopics: string[];
  answerCoverage: number;
  unansweredQuestions: string[];
  weakAnswers: Array<{ question: string; reason: string }>;
  studyRecommendations: string[];
  frequentDirections: string[];
  summary?: string;
}

export async function generatePostInterviewAnalysis(snapshot: InterviewSnapshot, provider: AnswerProvider, model: string, signal?: AbortSignal): Promise<PostInterviewAnalysis> {
  const questions = snapshot.questions.map((question) => ({ question: question.text, status: question.status, answer: snapshot.answers.find((answer) => answer.questionId === question.id)?.text ?? "" }));
  const transcript = snapshot.transcripts.slice(-12).map((item) => `${item.source}: ${item.text}`).join("\n").slice(-6_000);
  const prompt = `请分析这场面试，只返回 JSON：{"technicalTopics":[],"answerCoverage":0,"unansweredQuestions":[],"weakAnswers":[{"question":"","reason":""}],"studyRecommendations":[],"frequentDirections":[],"summary":""}。问题和答案：${JSON.stringify(questions)}。最近对话：${transcript}`;
  let text = "";
  for await (const delta of provider.stream({ model, sections: [{ name: "system/base", content: "你是面试复盘分析器。只根据输入，不虚构经历。" }, { name: "question", content: prompt }] }, signal)) text += delta;
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Partial<PostInterviewAnalysis>;
      return {
        technicalTopics: Array.isArray(parsed.technicalTopics) ? parsed.technicalTopics.map(String) : [],
        answerCoverage: typeof parsed.answerCoverage === "number" ? Math.max(0, Math.min(1, parsed.answerCoverage)) : 0,
        unansweredQuestions: Array.isArray(parsed.unansweredQuestions) ? parsed.unansweredQuestions.map(String) : [],
        weakAnswers: Array.isArray(parsed.weakAnswers) ? parsed.weakAnswers.map((item) => ({ question: String(item.question ?? ""), reason: String(item.reason ?? "") })) : [],
        studyRecommendations: Array.isArray(parsed.studyRecommendations) ? parsed.studyRecommendations.map(String) : [],
        frequentDirections: Array.isArray(parsed.frequentDirections) ? parsed.frequentDirections.map(String) : [],
        ...(parsed.summary ? { summary: String(parsed.summary) } : {})
      };
    } catch { /* fall back to a truthful local summary */ }
  }
  const answered = questions.filter((item) => Boolean(item.answer)).length;
  return { technicalTopics: [], answerCoverage: questions.length ? answered / questions.length : 0, unansweredQuestions: questions.filter((item) => !item.answer).map((item) => item.question), weakAnswers: [], studyRecommendations: [], frequentDirections: [], summary: text.slice(0, 1_000) };
}
