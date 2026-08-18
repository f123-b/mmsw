# Phase 1.1 收口报告

## 当前状态

`Phase 1 IMPLEMENTATION COMPLETE`
`Phase 1 CI PENDING`
`Phase 1 WINDOWS AUDIO VALIDATION PENDING`
`Phase 2 NOT STARTED`

本轮完成 Phase 1.1 Audio Foundation Final Fix。CI 和真实 Windows 音频验收必须依据实际运行结果更新，不能用代码存在代替通过。

## 修复项

- `AudioBuffer` 保存源设备采样率，3 秒上限和 duration 对 16k、44.1k、48k 分别正确计算，并精确丢弃 oldest frames。
- 新增 `PcmPacketAssembler`，任意 stdout chunk 都只产生完整的 2560-byte PCM packet。
- Sidecar 每秒上报 `audio_drift`，提供 MIC/SYSTEM available frames、signed drift frames、drift ms 和 normal/warning/degraded 状态。
- AudioManager 在 READY 稳定 2 秒后重置 recovery backoff；READY 后立即崩溃不会立刻重置退避。
- 新增 `Ctrl+Alt+P` 全局快捷键切换 Overlay Interactive/Passive。
- ScreenshotManager 使用 `screen.getPrimaryDisplay().id` 匹配屏幕来源，找不到时记录 diagnostic 并 fallback。
- 修复 PCM interleave 测试，覆盖量化后的正负值和 MIC/SYSTEM 左右顺序。
- raw PCM 停留在 Electron Main 的 `pcm-packet` 边界，不再广播到 Main Window 或 Overlay Renderer。
- 增加 Windows NSIS packaging job 和 `InterviewCopilot-Windows-Installer` artifact。

## 测试结果

当前本地可执行检查：

- `npm test`：通过，桌面 14 + 协议 5 + shared 4，共 23 tests。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `cargo fmt --check`：通过。
- `cargo test` / `cargo check`：本机被缺少 Visual C++ `link.exe` 阻断，未宣称通过。

## Windows CI 状态

提交推送后检查 `.github/workflows/ci.yml` 的 `desktop-and-rust` 和 `package-windows` 两个 job：

- `desktop-and-rust`：npm tests/typecheck/build、cargo test/check。
- `package-windows`：`npm run package:win`，并上传 NSIS 安装包 artifact。

当前提交尚未有新的 Actions 结果；在 Actions 实际成功前，状态保持 `Phase 1 CI PENDING`。

## Packaging 状态

打包入口统一为：

```powershell
npm run package:win
```

它从 workspace 目录执行 Sidecar release build、Electron build 和 electron-builder NSIS 打包。最终安装包应包含：

本地执行结果：在 Sidecar release build 阶段因缺少 `link.exe` 失败，因此本地 installer 未生成；Windows CI job 负责验证完整命令。

```text
resources/audio-sidecar/interview-audio.exe
```

## 剩余人工验证

- Windows MIC / SYSTEM Probe 和 A/B/C 独立音频验证。
- USB microphone、Bluetooth output、默认设备变化和 Sidecar crash recovery。
- 多显示器 Primary Display 截图验证。
- `Ctrl+Alt+P` 在 Passive/Interactive 间恢复验证。
- 安装 NSIS artifact 后的 Sidecar 资源路径和启动验证。

完整步骤见 [phase-1-validation.md](./phase-1-validation.md)。

## 已知问题

- 当前环境缺少 Visual C++ `link.exe` 时，Rust 二进制无法在本机链接；Windows CI 使用 `windows-latest` 验证。
- drift 当前只观测和上报，不做 PLL、adaptive resampling 或主动丢帧。
- 当前没有 Streaming ASR、Question Detector、LLM Answer、RAG、Profile 或 Preparation Agent。

## Phase 2 readiness

代码边界已为后续 Realtime Transport 预留，但 Phase 2 仍未开始。完成 Windows CI、打包安装验证和真实音频 A/B/C 后，才建议进入 Phase 2。
