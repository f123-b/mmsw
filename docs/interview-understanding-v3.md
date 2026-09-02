# 真实面试理解系统 V3

V3 的生产链路是：

```text
原始 ASR 片段
  -> CanonicalRemoteTurnAssembler（按 interviewer turn 组装）
  -> InterviewUnderstandingStateMachine
       -> SpeechActV3
       -> ContextualQuestionRewriter
       -> SemanticQuestionCompletion
       -> ConversationAnchorState / QuestionPendingLedger
       -> QuestionCommitGate
  -> QUESTION_COMMITTED
  -> Project QA / AnswerPlanner / Coverage / Quality / Claim Gate
  -> answer_end
```

准确面试使用 `ACCURATE_INTERVIEW`：未完成、低置信度 ASR、未解析引用、未锁定项目和严格项目题库未命中都会等待或拒答。FAST_PRACTICE 保留原有低延迟检测和生成路径，便于练习与兼容旧集成。

V3 的 `QuestionCommitGate` 是唯一提交权威；桌面协调器只有收到带 `commitAuthority: "understanding-v3"` 的 `QUESTION_COMMITTED` 才会在准确模式调度回答。所有草稿、等待原因、ASR 修复、引用、项目锁和题目槽位都可通过 `interview:get-understanding-state` 读取，并通过 `INTERVIEW_DECISION_TRACE` 记录。

项目问题在准确模式只允许当前锁定项目的已验证题库精确命中，或同时满足分数和 rerank margin 的强匹配；partial/no-match 不得回退到全局知识、其他项目或自由生成。答案内容在 `answer_end` 前经过覆盖、深度、grounding、口语和事实一致性检查。
