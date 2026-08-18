# Interview Copilot

这是一个独立实现的实时 AI 面试辅助桌面应用，按照《AskCc 功能等价复刻技术规格书》分阶段建设，不复用 AskCc 的专有源码、服务端代码、题库或私有数据。

## 当前进度

当前提交完成 Phase 1 的桌面端基础骨架：

- Electron `main → preload → renderer` 三层隔离
- React 主界面与透明 Overlay 窗口
- 统一的 Zod 协议包，包含音频设备、电平、健康状态和错误事件
- Session 状态机和全局快捷键入口
- Rust Audio Sidecar CLI 契约与 Windows 音频后端边界
- 自动化测试覆盖 Session 状态转移、音频协议和电平归一化

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
```

## 目录

```text
apps/desktop       Electron + React 桌面端
packages/protocol  Client / Main / Sidecar 共用协议
packages/shared    跨模块领域状态机和纯函数
crates/audio-sidecar Rust 音频 Sidecar
docs               阶段性架构和验收记录
```
