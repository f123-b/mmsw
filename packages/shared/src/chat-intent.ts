export const CHAT_INTENTS = [
  "project_analysis",
  "resume_analysis",
  "job_fit_analysis",
  "question_bank_analysis",
  "interview_coach",
  "knowledge_query",
  "action_request",
  "general_technical"
] as const;

export type ChatIntent = typeof CHAT_INTENTS[number];

export interface ChatContextPlan {
  intent: ChatIntent;
  includeResume: boolean;
  includeJobDescription: boolean;
  includeProjectMemory: boolean;
  includeQuestionBank: boolean;
  includeKnowledge: boolean;
  label: string;
}

const includesAny = (text: string, words: string[]): boolean => words.some((word) => text.includes(word));

/** Deterministic first-pass routing keeps chat context small and explainable. */
export function planChatContext(userMessage: string): ChatContextPlan {
  const text = userMessage.trim().toLowerCase();
  const project = includesAny(text, ["项目", "project", "架构", "模块", "负责", "技术选型", "难点", "优化", "性能", "bug"]);
  const resume = includesAny(text, ["简历", "resume", "经历", "自我介绍", "个人优势"]);
  const job = includesAny(text, ["jd", "岗位", "职位", "招聘", "要求", "匹配", "面试官"]);
  const questions = includesAny(text, ["题库", "题目", "怎么答", "如何回答", "标准答案", "八股", "代码题"]);
  const action = includesAny(text, ["帮我写", "生成", "整理", "修改", "导入", "创建", "删除", "保存"]);
  const knowledge = includesAny(text, ["资料", "文档", "代码库", "仓库", "规范", "源码", "知识库", "依据"]);

  const intent: ChatIntent = project ? "project_analysis" : resume && job ? "job_fit_analysis" : resume ? "resume_analysis" : questions ? "question_bank_analysis" : action ? "action_request" : knowledge ? "knowledge_query" : job ? "job_fit_analysis" : text ? "general_technical" : "interview_coach";
  return {
    intent,
    includeResume: ["resume_analysis", "job_fit_analysis", "interview_coach"].includes(intent),
    includeJobDescription: ["job_fit_analysis", "interview_coach"].includes(intent),
    includeProjectMemory: ["project_analysis", "job_fit_analysis", "interview_coach"].includes(intent),
    includeQuestionBank: ["question_bank_analysis", "interview_coach", "job_fit_analysis"].includes(intent),
    includeKnowledge: ["project_analysis", "question_bank_analysis", "knowledge_query", "general_technical", "interview_coach"].includes(intent),
    label: intent === "project_analysis" ? "项目分析" : intent === "resume_analysis" ? "简历分析" : intent === "job_fit_analysis" ? "岗位匹配" : intent === "question_bank_analysis" ? "题库准备" : intent === "knowledge_query" ? "资料检索" : intent === "action_request" ? "资料整理" : intent === "interview_coach" ? "面试辅导" : "技术问答"
  };
}
