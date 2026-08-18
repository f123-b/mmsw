# Phase 1：桌面端与音频基础链路

## 目标

建立 Electron 三层边界、独立 Overlay、统一协议和 Audio Sidecar 生命周期管理，为 Windows WASAPI 双通道采集提供稳定宿主。

## 已实现

1. Renderer 只通过 `contextBridge` 暴露的 `window.interviewCopilot` 调用主进程。
2. Main 进程负责窗口、Overlay、快捷键和 Sidecar 生命周期。
3. `packages/protocol` 是音频事件与设备描述的唯一 schema 来源。
4. `packages/shared` 的 Session 状态机拒绝非法转移，避免多个 boolean 拼接状态。
5. Sidecar 使用 stdout 输出 PCM，stderr 输出 JSON Lines 健康/电平/Probe/Buffer 事件。
6. Overlay 支持 Interactive / Passive 两种模式，不启用任何规避第三方监控的隐私策略。
7. PCM 经 Main 内部 packet assembler 固定为 2560 bytes 后保留在 Main，不发送给 Renderer。
8. Sidecar 每秒上报 MIC / SYSTEM 可用帧差和 drift 状态，不主动丢弃 drift 数据。

## Sidecar 接口

```text
interview-audio.exe --list-devices --json
interview-audio.exe --probe-only
interview-audio.exe --meter-only
interview-audio.exe --input-device-id <id> --output-device-id <id>
```

正式音频数据使用 16 kHz、PCM16、双声道、40 ms packet：640 frames × 4 bytes = 2560 bytes。Sidecar 的音频采集实现保持在 Rust 进程内，Electron 只消费结构化事件和进程状态。

## 本阶段验收

- [x] UI 能显示 MIC / SYSTEM 两条独立电平和 detected 状态。
- [x] Audio Sidecar 异常不会让 Electron 直接退出，UI 显示 DEGRADED / RECOVERING / FAILED。
- [x] Overlay 可以打开、隐藏并通过 Main IPC 切换 Passive 模式。
- [x] 设备枚举、选择、持久化、失效回退和 2 秒 Probe 已接入。
- [x] PCM stdout 与 JSON stderr 已物理分离。
- [x] PCM stdout 任意 chunk 已组装为精确 2560-byte packet；Renderer 不接收 raw PCM。
- [x] 源采样率 buffer 上限和 duration 已修正为各自 3 秒。
- [x] Audio drift metrics、`Ctrl+Alt+P` Overlay 模式快捷键和 Primary Display 截图选择已接入。
- [x] 协议、Session、Overlay、恢复退避和 Rust 纯函数有自动测试。
- [ ] 真实 MIC / WASAPI Loopback A/B/C 验证：`REQUIRES_MANUAL_WINDOWS_VALIDATION`。

## 下一阶段

详细收口状态和人工验证步骤见 [phase-1-final.md](./phase-1-final.md) 与 [phase-1-validation.md](./phase-1-validation.md)。Phase 2 仍未开始。
