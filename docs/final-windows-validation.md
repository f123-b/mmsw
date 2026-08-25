# Windows 最终发布验收记录

这份记录用于真实 Windows 环境填写，不把 mock、类型检查或 CI 当作麦克风、系统回采和真实 Deepgram 验收证据。

## 环境

- Windows 版本：
- CPU / 内存：
- Desktop commit：
- CI run：
- Installer SHA-256：
- Deepgram model：`nova-3`
- Deepgram language：`zh-CN`

## 安装与配置

- [ ] 仅安装 `Interview Copilot Setup.exe`，不安装 Node/npm。
- [ ] 启动安装后的 EXE，不打开项目源码或终端。
- [ ] Settings → `ASR Provider = Deepgram Direct`。
- [ ] 在软件内输入 Deepgram API Key；不配置 `DEEPGRAM_API_KEY` 环境变量。
- [ ] Settings → `Language = 中文（简体）`，保存后重启仍保持。
- [ ] 选择 Microphone 和 System Audio，点击开始面试。
- [ ] ASR 诊断显示 Provider、Model、Language、MIC/REMOTE 状态；不显示 API Key 或 token。

## 音频与 ASR 场景

| 场景 | 操作 | 预期 | 结果 / 证据 |
|---|---|---|---|
| A | 只讲话：`我主要负责 FOC 控制` | MIC meter/transcript active，REMOTE quiet，0 questions | |
| B | 只播放系统音频：`为什么中断服务程序要快进快出？` | SYSTEM meter/transcript active，REMOTE question confirmed，AUTO Answer 和 Overlay 出现 | |
| C | 用户讲话 + 电脑音频同时 | MIC / REMOTE transcript 独立，QuestionDetector 只处理 REMOTE | |
| D | 连续播放：`介绍一下你的项目`、`为什么使用 DMA`、`如果换成 FreeRTOS 呢` | 3 questions，3 answers，History 保存 3 条 | |
| E | 关闭电脑声音、恢复声音、切换输出设备 | Audio/ASR 进入恢复态，恢复后继续工作，不产生错误问题 | |
| F | 输入错误 Deepgram Key | UI 明确显示认证失败，不无限 reconnect | |

确认项：

- [ ] 正式面试没有走 `meterOnly:true`。
- [ ] 每个 PCM packet 恰好 2560 bytes，16kHz / stereo / 40ms。
- [ ] LEFT 只对应 MIC，RIGHT 只对应 SYSTEM。
- [ ] Deepgram 两个 WebSocket 都 OPEN 后才显示 listening、才发送队列中的 PCM。
- [ ] 连接超过约 2–3 秒时只保留有上限的最新 PCM，不无限积压。
- [ ] Deepgram `Finalize` 后最后 final transcript 到达，再在短 timeout 后关闭连接。
- [ ] `Last Partial Latency`、`Last Final Latency`、Reconnect Count、Dropped PCM 可见。
- [ ] API Key 不出现在 Renderer、URL、日志、诊断消息和 SQLite 明文配置中。
- [ ] MIC transcript 进入 History/recent context，但绝不进入 QuestionDetector。

## 自动化发布前门禁

在仓库根目录执行，记录完整命令输出和日期；任何失败都不能标记 GO：

- [ ] `npm test`
- [ ] `npm run benchmark:question`
- [ ] `npm run benchmark:real-interview`
- [ ] `npm run test:soak`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run functional:e2e`
- [ ] `npm run probe-failure:e2e`
- [ ] `npm run shutdown-process:e2e`
- [ ] `npm run package:win`
- [ ] `npm run verify:package`
- [ ] `cargo fmt --manifest-path crates/audio-sidecar/Cargo.toml --all -- --check`
- [ ] `cargo test --manifest-path crates/audio-sidecar/Cargo.toml --all`
- [ ] `cargo check --manifest-path crates/audio-sidecar/Cargo.toml --all`

## 免安装包与运行时探针

- [ ] 解压/运行 unpacked 目录或免安装包时，主窗口可见且 renderer 无白屏。
- [ ] `verify-package` 确认 `resources/app.asar`、capture helper、VAD 资产和 local-asr-service 资源路径。
- [ ] 首次启动不依赖当前仓库、Node/npm、开发服务器或 PowerShell 窗口。
- [ ] 关闭窗口后 Electron、capture helper、OpenASR、Python facade 均退出；不能残留后台进程。
- [ ] 启用 Local Fun-ASR-Nano 时，诊断分别显示 Python、venv、requirements、OpenASR、model、facade/backend port、runtime 状态。
- [ ] VAD 诊断明确显示 `provider=silero|energy`、`fallback`、`ready`、`reason`；Silero 失败时明确记录 fallback 原因。
- [ ] QuestionTrace 记录 `questionTraceId`、ASR final/speech end、检测/确认、检索、LLM 首 token、答案完成时间及派生延迟；不包含原始转写文本或 API Key。

## 结构化 Chat 与审批安全

- [ ] 结构化回答中的 sources/cards/actions 能在 UI 恢复显示，普通 Markdown 仍按普通回答显示。
- [ ] 每个 action 都显示 pending 和 requiresConfirmation；未点击确认不写入项目事实、题库或其他 SQLite 数据。
- [ ] 审批时校验 conversation、message、action id、payload 和 source evidence；篡改 payload、缺少 evidence、重复审批都得到可理解错误。
- [ ] action 执行后卡片状态变为 approved/failed，并能在重新打开会话后恢复。

## 失败注记模板

每个未执行或失败项至少记录：时间、命令/操作、环境、日志路径、现象、是否可复现、阻塞发布的原因和下一步负责人。不能用 mock、静态代码存在或历史 CI 结果替代真实 Windows 音频、真实 Provider、安装包启动和进程关闭证据。

## 发布结论

- 自动化测试：PASS / FAIL
- 真实 Windows 音频：PASS / FAIL / 未执行
- 真实 Deepgram 中文链路：PASS / FAIL / `REQUIRES_REAL_DEEPGRAM_VALIDATION`
- NSIS 安装与卸载：PASS / FAIL
- 结论：GO / NO-GO
- 阻塞项：
