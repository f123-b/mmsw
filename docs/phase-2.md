# Phase 2：Realtime Transport、PCM Streaming 与双通道 Transcript

## 当前状态

`Phase 2 IMPLEMENTATION COMPLETE`

CI 和真实 ASR 服务联调仍属于异步验证项，不阻塞后续阶段开发。

## 已实现

- `packages/protocol` 增加统一 Realtime WebSocket 消息 schema：连接、心跳、ASR 状态、`asr_partial`、`asr_final`、问题/答案事件和统一 runtime error。
- Main 进程增加 `RealtimeSession`，只在 Main 发送 PCM 二进制；Renderer 不接触原始 PCM。
- WebSocket 使用短期 `ticket` 参数建立连接，未引入长期 Access Token URL。
- 连接断开后采用 `1s / 2s / 4s / 8s / 10s` 上限退避；手动断开会清空队列和 Transcript 状态。
- PCM 发送队列上限 3 秒（192000 bytes），拥塞时丢弃最老包，避免 ASR 延迟无限增长。
- `TranscriptStabilizer` 分别维护 `mic` 与 `remote`，partial 只用于当前显示，final 才进入历史。
- 桌面端增加 Realtime URL/ticket 连接入口，以及 MIC/REMOTE Transcript 面板。

## 本地验证

- `npm test`：desktop 16、protocol 7、shared 6 全部通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

## 下一步

Phase 3 在稳定 Transcript 上实现 Question Detector、Debounce、Deduplication 和 Supersede；ASR 服务端实际联调在最终 E2E 阶段统一验收。
