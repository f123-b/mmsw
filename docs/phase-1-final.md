# Phase 1 收口报告

## 状态

`Phase 1 IMPLEMENTATION COMPLETE`
`Phase 1 CI PENDING`
`Phase 1 WINDOWS AUDIO VALIDATION PENDING`

尚未满足正式进入 Phase 2 的条件，原因是真实 Windows 音频设备验证和本机 Rust MSVC 链接尚未完成。

## 完成内容

- Electron 生产环境使用 `loadFile`，开发环境使用 Vite URL；主窗口和 Overlay 均覆盖。
- Overlay Passive/Interactive 切换通过 Main IPC，真实调用 `setFocusable` 和 `setIgnoreMouseEvents`。
- 设备自动枚举、默认设备选择、上次选择持久化和失效设备回退。
- 2 秒 Probe 统计 callback、sample、sample rate、channels 和 peak；没有 callback/sample 不会报告 READY。
- MIC / SYSTEM detected 状态和音频测试展示。
- ScreenshotManager 使用 `desktopCapturer`，保存临时文件，按 1280 最大尺寸和 PNG/JPEG 规则处理，并在 UI 预览。
- Sidecar stdout 保留给 PCM，stderr 输出 JSON event；Electron Main 通过 `pcm-packet` 内部边界接收完整 packet，不向 Renderer 广播 raw PCM。
- Source-rate buffer、audio drift、Overlay `Ctrl+Alt+P` 和 Primary Display screenshot 已修复。
- Sidecar 自动恢复使用 1/2/4/8/10 秒退避，恢复前重新枚举设备；手动停止不会自动重启。
- Rust Sidecar 拆分为 capture、device、resample、mixer、packet、meter、health、protocol、cli 模块。
- 添加 Rust resampler、mono、interleave、packet size、buffer overflow 测试。
- 添加 Windows CI，覆盖 npm test/typecheck/build、cargo test/check 和独立 NSIS packaging job。
- 添加 electron-builder Windows NSIS 打包配置，Sidecar 进入 `resources/audio-sidecar/interview-audio.exe`。

## 测试结果

当前环境已通过：

- `npm test`
- `npm run typecheck`
- `npm run build`
- Electron dev mode 启动检查
- `cargo fmt --check`

当前环境未通过/未完成：

- `cargo test` / `cargo check`：环境缺少 Visual C++ `link.exe`，需要 Windows Build Tools。
- `npm run package:win`：同样在 Sidecar release build 阶段被缺少 `link.exe` 阻断。
- 真实 MIC / WASAPI Loopback A/B/C 验证：需要人工连接音频设备执行 [phase-1-validation.md](./phase-1-validation.md)。

## Phase 2 接口

- stdout：原始 PCM16 stereo packet。
- stderr：JSON Lines health/meter/probe/buffer event。
- Electron Main：`pcm-packet` 内部事件；Renderer 只接收 `audio:event`、进程状态和截图/诊断等非 PCM 信息。
- packet：16 kHz、40 ms、640 frames、2560 bytes。

## 已知限制

- 当前没有 Streaming ASR、Question Detector、LLM Answer、RAG、Profile 或 Preparation Agent。
- Windows 真机验证完成前，不能宣称 MIC/SYSTEM 物理隔离已经验收。
