# Windows 发布验收记录

这份记录用于最终发布前填写真实环境结果，不把本地 mock 或类型检查当作硬件验收。

## 环境

- Windows 版本：
- CPU / 内存：
- Node.js / npm：
- Rust / MSVC：
- Audio Sidecar commit：
- Desktop commit：
- CI run：
- Installer SHA-256：

## 音频 A/B/C

| 场景 | 结果 | 证据 |
|---|---|---|
| A. 只播放系统声音 | PASS / FAIL | MIC 峰值、SYSTEM 峰值、录音片段 |
| B. 只说话 | PASS / FAIL | MIC 峰值、SYSTEM 峰值、录音片段 |
| C. 同时说话和播放 | PASS / FAIL | 双通道峰值、ASR source、录音片段 |

确认项：

- [ ] 正式面试没有走 `meterOnly:true`。
- [ ] 每个 PCM packet 恰好 2560 bytes，16kHz / stereo / 40ms。
- [ ] LEFT 只对应 MIC，RIGHT 只对应 SYSTEM。
- [ ] 断开或重启输出设备后能进入 RECOVERING，并在设备恢复后回到 READY/RUNNING。
- [ ] 3 秒音频队列有上限，过载时只丢弃最旧 packet。
- [ ] 持续 drift 超过 80ms 时能看到 warning/degraded，而不是静默漂移。

## Provider 与端到端

- [ ] ASR Gateway 能接收 PCM 并返回 `asr_partial` / `asr_final`。
- [ ] remote 最终片段会聚合成完整 utterance 后再确认问题。
- [ ] AUTO 模式能触发答案；MANUAL 模式只在 `Ctrl+Alt+A` 触发。
- [ ] 新问题会取消旧答案，cancel reason 正确，旧答案在新流首 delta 前保持稳定。
- [ ] LLM SSE、Embedding 和可选 Reranker 使用真实配置模型。
- [ ] API Key 不出现在 Renderer、日志、诊断消息和 SQLite 明文配置中。
- [ ] Resume/JD、PDF/DOCX、知识库导入、History 分析和 Preparation 审批可用。

## 发布结论

- 自动化测试：PASS / FAIL
- 真实 Windows 音频：PASS / FAIL / 未执行
- 真实 Provider：PASS / FAIL / 未执行
- NSIS 安装与卸载：PASS / FAIL
- 结论：GO / NO-GO
- 阻塞项：
