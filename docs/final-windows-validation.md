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

## 发布结论

- 自动化测试：PASS / FAIL
- 真实 Windows 音频：PASS / FAIL / 未执行
- 真实 Deepgram 中文链路：PASS / FAIL / `REQUIRES_REAL_DEEPGRAM_VALIDATION`
- NSIS 安装与卸载：PASS / FAIL
- 结论：GO / NO-GO
- 阻塞项：
