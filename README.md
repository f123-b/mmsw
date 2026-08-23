# Interview Copilot

Interview Copilot 是 Windows 优先的实时 AI 面试辅助桌面应用：它从 MIC 和系统回采分别捕获音频，保持 LEFT = MIC、RIGHT = SYSTEM 的双声道 PCM16 LE 数据，经 ASR 转写、问题确认、Profile/知识库检索和流式模型回答后，把稳定答案显示在桌面悬浮窗中，并把面试记录保存到本地 SQLite。

## 产品能力

- 正式面试入口由 Electron Main 的 `InterviewCoordinator` 管理，Renderer 不直接编排音频、ASR、问题和回答状态。
- 正式面试使用 `meterOnly: false`，产生 16kHz、双声道、40ms、2560-byte PCM16 LE packet；“测试音频”是独立的电平诊断路径。
- 默认 ASR 是 Electron Main 内置的 Deepgram Direct：Main 从 Windows `safeStorage` 读取 API Key，拆分 LEFT/RIGHT PCM 后直接建立 MIC/SYSTEM 两个 Deepgram Listen WebSocket；安装后的用户不需要 Node、npm 或手工启动 Gateway。
- `apps/asr-gateway` 作为 Advanced Custom Gateway 保留，默认只监听 `127.0.0.1`，只通过 WebSocket URL 的短期 `ticket` 校验连接；长期 Deepgram API Key 不进入 Desktop Renderer 或 Realtime 协议。
- 远端最终转写先经过连续片段聚合，再由问题检测器确认；支持隐式提问、500ms 静音确认、去重、追问 supersede，以及 AUTO/MANUAL 两种回答模式。
- LLM 使用 OpenAI-compatible SSE；支持 FAST/NORMAL/DEEP、可取消请求、超时和有限重试。答案输出提示为中文 60–120 或 120–250 字 sneak peek，并保持旧答案直到新答案首个 delta 到达。
- Provider Center 支持 LLM、ASR、Embedding 和可选 Reranker 配置；API Key 通过 Windows `safeStorage` 保存，不返回 Renderer、不写入日志。
- Profiles、Resume/JD、Skill、Knowledge Base、Interview History 均使用 `%APPDATA%/InterviewCopilot/interview-copilot.sqlite`；密钥单独保存到同目录的安全存储文件。
- Resume/JD 支持 TXT、MD、PDF、DOCX、HTML；知识库支持 TXT、MD、PDF、DOCX、HTML、PPTX、XLSX，文档会被分块保存，可选 embedding 后先取 16 个候选再收敛到 6 个上下文片段。
- Personal Engineering Memory 会在 Resume、项目资料或 GitHub 仓库 ZIP 导入后生成结构化项目、模块、技术点、问题解决过程和项目面试问题；项目题回答优先使用这些真实证据，并通过第一人称和技术事实校验。
- Preparation Agent 使用最多 40 步的模型/工具循环，写入和外部动作需要用户批准；事件会实时显示在 Preparation 页面。
- `Ctrl+Alt+A` 重新回答当前问题，`Ctrl+Alt+S` 截图并请求 Vision Provider，`Ctrl+Alt+D` 显示悬浮窗，`Ctrl+Alt+P` 切换悬浮窗模式，`Ctrl+Alt+Q` 结束面试。
- 更新包校验 SHA-256 和 RSA 签名；应用、音频、Realtime 日志分别写入 `%APPDATA%/InterviewCopilot/logs`，自动脱敏并轮转。

## 快速开始

开发环境要求：Windows 11、Node.js 22+、npm 10+；构建真实 Audio Sidecar 还需要 Rust stable 和 MSVC linker。最终用户只需安装 Windows EXE。

```powershell
npm install
npm run dev
```

首次打开后：

1. 在“Profiles”创建或选择档案，导入 Resume 和 JD。
2. 在“知识库”导入项目资料；如果配置了 Embedding Provider，会保存向量并启用混合检索。
3. 在“设置”选择 `ASR Provider → Deepgram Direct`，填写 Deepgram API Key、模型（默认 `nova-3`）和语言（默认 `中文（简体）`）；API Key 只保存到系统安全存储。只有使用自定义 Gateway 时，才在 Advanced 中填写 Gateway URL 和短期 token。
4. 返回“首页”选择 MIC / System Audio，点击“开始面试”。

正常面试页面不要求用户手工配置 Node/npm 或启动服务；Direct 连接由 Electron Main 自动建立。Custom Gateway 的 URL 和 ticket 仅在高级设置中使用。

选择 `Local Fun-ASR-Nano` 时，首次需要安装 OpenASR、下载 `funasr-nano:q8` 模型并为 `apps/local-asr-service` 安装 Python 依赖。之后点击设置中的“测试连接”或“开始面试”，Electron Main 会自动、隐藏地启动 OpenASR 和本地 WebSocket facade，并在退出软件时清理自己启动的进程；不需要用户打开两个服务窗口。详见 [`apps/local-asr-service/README.md`](apps/local-asr-service/README.md)。

## ASR Gateway 合约与真实 Provider

如果必须使用 Advanced Custom Gateway（需要真实 Deepgram API Key；未提供时保留 `REQUIRES_REAL_DEEPGRAM_VALIDATION`），可在开发机上启动：

```powershell
$env:DEEPGRAM_API_KEY = "..."
$env:INTERVIEW_COPILOT_GATEWAY_TOKEN = "短期网关 token"
$env:INTERVIEW_COPILOT_ASR_HOST = "127.0.0.1"
npm --workspace apps/asr-gateway run dev
```

然后在设置中选择 `Custom Gateway` 并把 URL 配为 `ws://127.0.0.1:8787`。Gateway 使用官方 Deepgram Listen 参数，并从 Desktop 的 `client_ready` 接收 model/language；Desktop 只接收项目 Realtime 协议的 `asr_partial` / `asr_final`。

自定义受信 Gateway 需要接受 Electron Main 发出的二进制 PCM packet：16kHz、双声道、signed PCM16 LE、每包 640 frames / 2560 bytes，并返回 JSON WebSocket 消息，例如：

```json
{"type":"asr_final","segment":{"id":"remote-1","source":"remote","text":"请介绍一下你的项目？","startMs":0,"endMs":1200,"final":true,"confidence":0.95}}
```

回答和检索 Provider 使用 OpenAI-compatible HTTP：LLM 使用 `/v1/chat/completions` SSE，Embedding 使用 `/v1/embeddings`。

## 本地验证

```powershell
npm test
npm run typecheck
npm run build
npm run package:win
```

`npm test` 包含 PCM packet、Realtime 恢复、Coordinator 软件 E2E、SQLite CRUD、Provider SSE、文档解析、Agent 审批、更新签名和日志脱敏测试。真实 Deepgram/LLM API Key 和 Windows WASAPI 设备仍需要在目标机器上手工验证；记录模板见 [`docs/final-windows-validation.md`](docs/final-windows-validation.md)。

## 目录

```text
apps/desktop       Electron Main / Preload / React Renderer
apps/asr-gateway   双声道拆分与 Deepgram Streaming ASR Gateway
packages/protocol  音频、ASR、Realtime 共用 Zod 协议
packages/shared    状态机、问题检测、回答、RAG、Agent、历史领域逻辑
crates/audio-sidecar Rust WASAPI / CPAL 双通道采集 Sidecar
docs               架构、验证和发布记录
```

个人工程经验架构说明见 [`docs/personal-engineering-memory.md`](docs/personal-engineering-memory.md)，数据库迁移脚本见 [`docs/migrations/009_project_memory.sql`](docs/migrations/009_project_memory.sql)。

## 当前验收边界

代码、TypeScript、协议、共享逻辑、软件 E2E 和 Windows NSIS 构建链已纳入仓库；最终验收仍需在真实 Windows 音频设备上确认 MIC、系统回采、设备失效恢复和真实 Provider 联调，并由 CI 的最后一轮结果确认发布包。
