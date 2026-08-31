# Interview runtime strict execution

本轮目标是保持实时回答低延迟，同时不因 ASR segment final 过早结束语义问题。

## 实现边界

- `PendingQuestionDraftAssembler` 是 QuestionGroup 形成前的 session-local assembly buffer，仅做本地、确定性的语义槽位分类。
- ASR `final` 只表示片段稳定；远端问题由 draft 的 setup/nucleus/constraint/output horizon 结束，不再把 provider final 自动提升为 semantic turn final。
- nucleus 后使用短 coalescing window；setup-only 片段不会单独触发回答。已完成回答之后到达的强约束会进入同组并生成 `AUGMENTATION`，无意义的 continuation 不产生 provider request。
- ClaimGate 仍保留，但 live streaming 只输出允许/改写后的句子或丢弃句子；审计提示只留在内部质量结果和 telemetry，不进入回答窗口。
- Native boundary 将 Windows wheel `mouseData` 转为 DOM semantic `deltaY`；Overlay runtime window 与 runtime card 均禁用大面积阴影。设置/帮助采用固定 footer，帮助页是实际路由。

## 回归指标

`packages/shared/src/interview/strict-interview-regression.test.ts` 固化了本轮 A-G 场景的本地 draft 回归。由于用户指定的 `面试记录-20260831-100359.md` 不在当前仓库、Git 历史或本机附件中，该测试使用用户消息中逐字给出的 A-G 场景，并在最终报告中明确区分这一限制。

当前输出：

```text
Question Recall             1.00
Multi-Segment Coverage      1.00
Constraint Coverage         1.00
Late Constraint Coverage    1.00
False Positive Rate         0.00
Late Constraint Drop        0
```

实时 coordinator replay：14 cases，failures 0，premature answers 0；late HardFault constraint 在首个回答可见后生成同组 augmentation，`LATE_CONSTRAINT_DROPPED` 为 0。

低延迟 benchmark（8 samples）：

```text
ASR Final → Question Confirmed       P50 227ms / P95 236ms / MAX 236ms
Question Confirmed → Provider Req    P50   1ms / P95   2ms / MAX   2ms
Provider Request → First Token       P50   3ms / P95   5ms / MAX   5ms
ASR Final → First Visible Token      P50 231ms / P95 241ms / MAX 241ms
```

上述运行时指标来自现有低延迟 benchmark；严格 A-G fixture 的本地 role classification 不调用远程 LLM。

## UI / native 验收

- Composer 的“网络搜索”“完全访问权限”假按钮已移除，`＋` 不再作为无动作入口。
- Sidebar DOM 已移除 profile footer card；历史列表位于 `sidebar-main-scroll`，设置和帮助位于固定 `sidebar-footer`。
- Help Center 提供 12 个主题和 5 步 Quick Start deep link；首次启动可跳过 onboarding，完成状态使用现有 device-local persistence。
- Overlay 显示模式复用 `appearance.mode`；`text_only` 透明、无 shadow/border/backdrop，并增加文字 shadow。自动跟随在问题、对话、回答内容变化时恢复到最新尾部，用户手动上滚仍可暂停。
- Windows wheel test 覆盖 native `-120`（向下 → DOM `+120`）和 `+120`（向上 → DOM `-120`），middle-click 路径继续独立处理。

## 收口验证（2026-08-31）

- Shared full regression: 96 test files, 477 tests passed.
- Desktop full regression: 57 test files, 288 tests passed, 1 skipped; coordinator replay 14/14 with 0 failures and 0 premature answers.
- Terminology rollout benchmark: Question Recall 1.00, Constraint Coverage 1.00, False Normalization Rate 0, Shadow Parity 1.00, High-Confidence Precision 0.90, normalization P95 1.90ms. Default remains `high_confidence`; `dynamic` is opt-in and no remote terminology correction was added.
- Runtime latency benchmark: ASR final → question confirmed P50 228ms / P95 238ms / MAX 238ms; question confirmed → provider request P50 1ms / P95 2ms / MAX 2ms; provider request → first token P50 3ms / P95 4ms / MAX 4ms; ASR final → first visible P50 231ms / P95 242ms / MAX 242ms.
- Windows installer: `apps/desktop/release/Interview Copilot Setup 0.1.0.exe` (195,624,857 bytes); `verify:package` passed. SHA-256: `1415BB50C4B97D1C5CB28E643FA78461BB7E26A2A8162D2DE0883659733B408E`.
