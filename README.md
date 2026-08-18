# Interview Copilot

这是一个独立实现的实时 AI 面试辅助桌面应用，按照《AskCc 功能等价复刻技术规格书》分阶段建设，不复用 AskCc 的专有源码、服务端代码、题库或私有数据。

## 当前进度

当前状态：`Phase 1 IMPLEMENTATION COMPLETE`，`Phase 1 CI PENDING`，`Phase 1 WINDOWS AUDIO VALIDATION PENDING`，`Phase 2 IMPLEMENTATION COMPLETE`，`Phase 3 IMPLEMENTATION COMPLETE`，`Phase 4 IMPLEMENTATION COMPLETE`，`Phase 5 IN PROGRESS`。

已完成 Phase 1 实现：

- Electron `main → preload → renderer` 三层隔离
- React 主界面与透明 Overlay 窗口
- 统一的 Zod 协议包，包含音频设备、电平、健康状态和错误事件
- Session 状态机和全局快捷键入口
- Rust Audio Sidecar CLI 契约与 Windows 音频后端边界
- MIC / SYSTEM 设备选择、2 秒 Probe、检测状态和截图基础能力
- PCM stdout 与 JSON stderr 分离、精确 2560-byte packet framing、3 秒源采样率 buffer 统计和 Sidecar 自动恢复
- MIC / SYSTEM clock drift 观测、Overlay `Ctrl+Alt+P` 模式切换和 Primary Display 截图选择
- 原始 PCM 保留在 Electron Main，不广播到 Main Window 或 Overlay Renderer
- Rust Sidecar 模块化、纯函数测试、Windows CI 和 NSIS 打包配置

已完成 Phase 2 实现：

- Realtime WebSocket protocol and Main-process PCM streaming
- Bounded 3-second PCM backpressure queue with oldest-packet eviction
- Independent MIC/REMOTE Transcript stabilization and partial/final rendering
- Realtime connection recovery with capped exponential backoff

已完成 Phase 3 实现：

- Remote Transcript question candidate and completeness scoring
- 500ms silence debounce with explicit question state machine
- 15-second duplicate suppression and supersede events

已完成 Phase 4 实现：

- Provider abstraction, FAST/NORMAL/DEEP answer modes and model routing
- Context-limited prompt sections for profile, skills, retrieval and transcript
- Stable streaming answer replacement and cancellation behavior

Rust 工具链未安装时，桌面端仍可完成 TypeScript 构建与协议/状态机测试；真实 WASAPI 采集需要在 Windows 上安装 Rust 后构建 `crates/audio-sidecar`。

## 开发环境

- Windows 11 优先
- Node.js 22+
- npm 10+
- Rust stable（构建 Audio Sidecar 时需要）

安装依赖并运行：

```powershell
npm install
npm run dev
```

可通过环境变量指定本地 Sidecar：

```powershell
$env:INTERVIEW_COPILOT_AUDIO_SIDECAR = "D:\\path\\to\\interview-audio.exe"
npm run dev
```

验证：

```powershell
npm test
npm run typecheck
npm run build
npm run package:win
```

真实 Windows 音频验证步骤见 [`docs/phase-1-validation.md`](docs/phase-1-validation.md)，Phase 1.1 收口记录见 [`docs/phase-1.1-final.md`](docs/phase-1.1-final.md)，Phase 2 记录见 [`docs/phase-2.md`](docs/phase-2.md)，Phase 3 记录见 [`docs/phase-3.md`](docs/phase-3.md)，Phase 4 记录见 [`docs/phase-4.md`](docs/phase-4.md)。在 CI 通过、人工执行 A/B/C 音频测试并完成 Rust MSVC 构建前，不将 Phase 1 标记为正式验收完成。

## 目录

```text
apps/desktop       Electron + React 桌面端
packages/protocol  Client / Main / Sidecar 共用协议
packages/shared    跨模块领域状态机和纯函数
crates/audio-sidecar Rust 音频 Sidecar
docs               阶段性架构和验收记录
```
