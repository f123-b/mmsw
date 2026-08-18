# Phase 1：桌面端与音频基础链路

## 目标

建立 Electron 三层边界、独立 Overlay、统一协议和 Audio Sidecar 生命周期管理，为 Windows WASAPI 双通道采集提供稳定宿主。

## 已实现

1. Renderer 只通过 `contextBridge` 暴露的 `window.interviewCopilot` 调用主进程。
2. Main 进程负责窗口、Overlay、快捷键和 Sidecar 生命周期。
3. `packages/protocol` 是音频事件与设备描述的唯一 schema 来源。
4. `packages/shared` 的 Session 状态机拒绝非法转移，避免多个 boolean 拼接状态。
5. Sidecar 使用 stdout 输出 JSON Lines 健康/电平事件，stderr 只用于诊断。
6. Overlay 支持 Interactive / Passive 两种模式，不启用任何规避第三方监控的隐私策略。

## Sidecar 接口

```text
interview-audio.exe --list-devices --json
interview-audio.exe --probe-only
interview-audio.exe --meter-only
interview-audio.exe --input-device-id <id> --output-device-id <id>
```

正式音频数据使用 16 kHz、PCM16、双声道、40 ms packet：640 frames × 4 bytes = 2560 bytes。Sidecar 的音频采集实现保持在 Rust 进程内，Electron 只消费结构化事件和进程状态。

## 本阶段验收

- [x] UI 能显示 MIC / SYSTEM 两条独立电平。
- [x] Audio Sidecar 异常不会让 Electron 直接退出，UI 显示 DEGRADED / FAILED。
- [x] Overlay 可以打开、隐藏并切换 Passive 模式。
- [x] 协议 schema 和 Session 状态机有自动测试。
- [ ] 在真实腾讯会议/浏览器场景验证 WASAPI Loopback 与 Mic 的物理隔离（需要 Rust 工具链和真实音频设备）。

## 下一阶段

Phase 2 将在现有协议之上接入 WebSocket、PCM backpressure、MIC / REMOTE 分离的 Streaming ASR 和 transcript stabilizer。
