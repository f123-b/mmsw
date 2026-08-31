# Interview Runtime 低延迟优化

本次改动只针对 Interview Runtime 的首答热路径，未改造 Overlay UI。目标是让“问题确认”和“第一段可见答案”尽快发生，并把可延迟的丰富检索放到后台。

## 修改前架构

```text
ASR Final
  -> TranscriptAggregator / 固定 silence 等待
  -> QuestionDetector
  -> 中间置信度时可能远程 LLM confirmer
  -> 重型 ContextProvider
       -> Profile / Project Snapshot / Resume / JD
       -> QuestionBank / Project QA / Comprehension
       -> Remote Embedding / RAG / Rerank
  -> Answer LLM
  -> 项目题 directDisplay 全量缓冲
  -> ClaimGate
  -> Quality Repair 可能再次请求 LLM
  -> Overlay
```

## 修改后架构

```text
ASR Partial --------------------------------------------------+
  -> 本地术语/候选问题预分析（不确认、不答题）                  |
                                                             v
ASR Final + endpoint/speech_final -> Fast Turn Completion
  -> Rules + Semantic Frame + Speech Act + Local ONNX
  -> QUESTION_CONFIRMED
  -> FAST_CONTEXT（会话缓存、当前主题、局部题库、Core QA、关键词检索）
  -> PROVIDER_REQUEST_STARTED / SENT
  -> Streaming Answer LLM
  -> Sentence ClaimGate（本地） -> FIRST_VISIBLE_TOKEN -> Overlay

QUESTION_CONFIRMED ------------------------------------------+
  -> RICH_CONTEXT 后台：Embedding / 向量检索 / 长简历 / 文档 / JD / Rerank
  -> 供下一轮 follow-up 或缓存使用；不阻塞首 token
```

## 主要根因与修复

| 根因 | 修复 |
| --- | --- |
| Live 的问题检测可能进入远程 confirmer | 生产 `QuestionDetector2` 显式使用 `questionRecognitionMode: "local_only"`；`hybrid_debug` 只保留给库调用/离线测试。 |
| ONNX 首次 predict 承担模型加载 | 面试启动阶段并行预热；失败只记录 `QUESTION_CLASSIFIER_WARMUP_FAILED`，规则/语义路径继续可用。 |
| 所有 final 进入同一长等待 | `TurnCompletionGate` 按 complete / ambiguous / incomplete / modifier 分档；明确的 endpoint 直接 0ms，普通明确问句 140ms，终端句 180ms，模糊句 260ms，不完整句 620ms。 |
| ASR endpoint 信息没有贯通 | 协议、Deepgram、Qwen、Gateway、Local Fun-ASR 和 direct segment 均传递 `endpoint`、`speechFinal`、`utteranceEnd`、`endOfTurn`。 |
| ContextProvider 在首答前执行全量 I/O/RAG | 面试开始预加载 `InterviewContextCache`；Live 调用只取 Fast Context。项目/个人题的 Rich Context 异步后台执行。远程 embedding 不再是首 token 依赖。 |
| 项目/个人题 `directDisplay=true` | Live 统一 `directDisplay=false`、`emitDeltas=true`，答案首个完整安全短句即可显示。 |
| ClaimGate 以完整答案为单位阻塞 | 新增本地 `StreamingSentenceClaimGate`，按句检查和弱化 ownership claim，不发远程请求；完成态仍保留最终 ClaimGate。 |
| 质量修复可能触发第二次 LLM | Live Coordinator 固定传 `allowQualityRepair=false`；保留手动/Deep/离线调用方的能力。 |
| Provider request 发出后仍允许静默 merge | Scheduler 增加 `requestSent`，发送前可合并，发送后只能 queue/supplement；新增回归测试。 |
| 只有零散 trace，没有正式分位数 | `RuntimeLatencyTelemetry` 记录每个阶段并输出 `count / p50 / p95 / max`，新增 IPC 查询和运行时 benchmark。 |

## 修改文件

- [apps/desktop/src/main/interview-coordinator.ts](/D:/电脑面试/apps/desktop/src/main/interview-coordinator.ts)：Live 状态、Fast/Rich 生命周期、首 token/首可见 token、Overlay 延迟埋点。
- [apps/desktop/src/main/index.ts](/D:/电脑面试/apps/desktop/src/main/index.ts)：Live local-only detector、Context Cache 预加载、Fast Context、后台 Rich Context、缓存失效。
- [apps/desktop/src/main/interview-context-cache.ts](/D:/电脑面试/apps/desktop/src/main/interview-context-cache.ts)：session-scoped immutable base context。
- [apps/desktop/src/main/runtime-diagnostics.ts](/D:/电脑面试/apps/desktop/src/main/runtime-diagnostics.ts)：正式 runtime latency samples/percentiles。
- [packages/shared/src/question/question-detector.ts](/D:/电脑面试/packages/shared/src/question/question-detector.ts)：`local_only | hybrid_debug` 模式。
- [packages/shared/src/interview/turn-completion-gate.ts](/D:/电脑面试/packages/shared/src/interview/turn-completion-gate.ts)：自适应完成窗口。
- [packages/shared/src/answer.ts](/D:/电脑面试/packages/shared/src/answer.ts)：流式句级 ClaimGate、`claim_gate_pass`、延迟 telemetry。
- [packages/shared/src/interview/answer-scheduler.ts](/D:/电脑面试/packages/shared/src/interview/answer-scheduler.ts)：request-sent 边界。
- [packages/protocol/src/index.ts](/D:/电脑面试/packages/protocol/src/index.ts)、[packages/shared/src/asr.ts](/D:/电脑面试/packages/shared/src/asr.ts)、ASR provider 文件：endpoint 信号贯通。
- 测试：`interview-runtime.test.ts`、`runtime-diagnostics.test.ts`、`answer.test.ts`、`question-detector-2.test.ts`、`turn-completion-gate.test.ts`、`answer-scheduler.test.ts`、`interview-context-cache.test.ts`。

## 延迟数据

### Baseline（优化前已记录）

旧的 Question E2E benchmark 没有 formal runtime latency sample；它通过固定 flush 模拟确认窗口，记录到：

| 指标 | Baseline |
| --- | ---: |
| Question confirmation P50 | 1200 ms |
| Question confirmation P95 | 3000 ms |
| Local classification P50 | 6.465 ms |
| Local classification P95 | 27.778 ms |
| ASR Final → First Visible Token | 未埋点 |

因此旧结果无法直接观测 provider 和 Overlay 阶段；这也是本次新增 runtime telemetry 的原因。

### 优化后 Runtime benchmark

`apps/desktop/src/main/interview-runtime.test.ts` 使用 8 个带 ASR endpoint 的完整 Coordinator 样本，最近一次运行结果如下。Provider 为受控本地测试流，网络模型耗时应通过同一 telemetry 在实际环境单独观察。

| 阶段 | P50 | P95 | MAX |
| --- | ---: | ---: | ---: |
| ASR Final → Question Confirmed | 12 ms | 19 ms | 19 ms |
| Question Confirmed → Provider Request | 1 ms | 1 ms | 1 ms |
| Provider Request → First Token | 2 ms | 3 ms | 3 ms |
| ASR Final → First Token | 15 ms | 22 ms | 22 ms |
| ASR Final → First Visible Token | 15 ms | 22 ms | 22 ms |
| Fast Context | 0 ms | 0 ms | 0 ms |
| Answer Delta → Overlay Visible | 0 ms | 0 ms | 0 ms |

ClaimGate 单元基准要求句级检查 `< 50ms`；Live runtime 也会输出 `CLAIM_GATE_FIRST_PASS`。

## 验证结果

- `npm.cmd run typecheck`：通过。
- `npm.cmd test`：通过；shared 91 个测试文件、454 个测试；desktop 55 个测试文件通过、1 个既有测试跳过，281 个测试通过、1 个跳过；protocol 2 个文件、11 个测试通过。
- `npm.cmd run build`：通过；Electron main/preload/renderer 均完成生产构建。
- `npm.cmd --workspace @interview-copilot/desktop run benchmark:realtime-runtime`：包含正式 runtime latency benchmark、warmup、endpoint、首 token 和 Overlay latency 检查。
- 题目识别回归：`QUESTION_E2E_BENCHMARK` precision/recall/F1 仍为 1，follow-up 和 utterance assembly 仍为 1，未牺牲连续追问与术语归一化。
- 流式项目答案：新增测试确认 `answer_start -> claim_gate_pass -> answer_delta -> answer_end`，且 provider 只调用一次，`allowQualityRepair=false` 不产生二次生成。

## Runtime telemetry 查询

主进程新增 `interview:get-runtime-latency` IPC，返回：

```ts
{
  sampleCount,
  stages: {
    asrFinalToQuestionConfirmedMs,
    questionConfirmedToProviderRequestMs,
    providerRequestToFirstTokenMs,
    asrFinalToFirstVisibleTokenMs,
    fastContextMs,
    claimGateMs,
    answerDeltaToOverlayVisibleMs
  }
}
```

每个 stage 都包含 `count / p50 / p95 / max`。Raw transcript 不进入该采样器；QuestionTrace 仍只保存受限 hash/长度与已有诊断字段。
