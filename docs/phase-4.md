# Phase 4：Answer Agent、Streaming Answer 与 Model/Context Router

## 当前状态

`Phase 4 IMPLEMENTATION COMPLETE`

## 已实现

- `AnswerProvider` 抽象，业务层不直接绑定某一家模型 SDK。
- `FAST / NORMAL / DEEP` 三种回答模式。
- `ModelRouter` 根据模式、问题长度和截图上下文选择 fast/reasoning/vision/low-latency route。
- `ContextRouter` 只选 Top 3 Skills、Top 6 retrieval chunks 和最近 12 条 Transcript。
- `PromptBuilder` 拆分 system/base、interview-style、profile、skill、retrieval、question、output-format sections。
- `StableAnswerStateMachine` 保持旧答案，收到新答案首个 delta 后才原子替换；取消生成不会清空已显示答案。
- Renderer 已接收 `answer_start`、`answer_delta`、`answer_end`、`answer_cancelled`，Overlay 显示稳定答案状态。

## 本地验证

- desktop：16/16 测试通过。
- protocol：7/7 测试通过。
- shared：13/13 测试通过。
- `npm run typecheck` 和 `npm run build`：通过。

下一阶段实现 Profile、Resume、JD、Skill 数据模型和 Skill Router。
