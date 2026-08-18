# Phase 3：Question Detector、Deduplication 与 Supersede

## 当前状态

`Phase 3 IMPLEMENTATION COMPLETE`

## 已实现

- Remote Transcript 进入独立 `QuestionDetector`，不允许 ASR partial 直接触发回答。
- 规则层识别疑问词、疑问标点、final 状态和上下文长度，输出 candidate、score 和 low/medium/high confidence。
- 完整度阈值默认 `0.82`，final 后默认等待 `500ms` 静默再确认。
- 状态覆盖 `IDLE → LISTENING → POSSIBLE_QUESTION → WAITING_COMPLETION → CONFIRMED → ANSWERING`。
- 15 秒去重窗口和相似度判断避免同一问题重复触发。
- 新问题确认时产生 `question_superseded` 事件，答案层可用 `answer_cancel` 取消旧生成。
- Renderer 只显示 candidate/confirmed 结果，Answer Generator 不直接监听原始 ASR。

## 本地验证

- shared QuestionDetector：10/10 测试通过。
- desktop：16/16 测试通过。
- `npm run typecheck` 和 `npm run build`：通过。

下一阶段实现 Answer Agent、流式增量输出、Stable Answer UI、Model Router 和 Context Router。
