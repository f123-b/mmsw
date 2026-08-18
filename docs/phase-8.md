# Phase 8：History、Interview Analysis、Metrics 与 Recovery

## 当前状态

`Phase 8 IMPLEMENTATION COMPLETE`

## 已实现

- InterviewHistoryStore 记录 Interview、final Transcript、Question、Answer；partial Transcript 不落历史。
- Interview metrics：时长、MIC/REMOTE transcript 数量和词数、问题数、回答率、首 token/总延迟均值。
- SessionRecovery 使用 `1s / 2s / 4s / 8s / 10s` 封顶退避。
- updater manifest 必须提供升级版本、下载 URL、64 位 SHA-256 和非空 signature，且版本必须高于当前版本。
- History/DB 仍通过可替换的 Store 边界接入，后续可替换 SQLite adapter，不让 UI 直接操作数据库。

## 本地验证

- shared：24/24 测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

## 最终验收剩余项

- Windows MSVC Rust link/build 和 NSIS 安装包。
- 真实 MIC/WASAPI Loopback A/B/C。
- 真实 Realtime ASR 服务联调、Question → Answer 流式 E2E。
- 最终一轮 GitHub Actions 完整完成并核对结果。
