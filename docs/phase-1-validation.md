# Phase 1 Windows 音频验证

状态：`REQUIRES_MANUAL_WINDOWS_VALIDATION`

本文件提供可执行的真机验证步骤。当前 Codex 环境可以运行 Windows/Electron，但没有可用的 Visual C++ `link.exe` 和可确认的用户音频设备，因此不能把真实 MIC / WASAPI Loopback 结果标记为通过。

## 前置条件

1. Windows 10 1703 或更高版本。
2. 安装 Visual Studio Build Tools 的 Desktop development with C++ 工作负载。
3. 安装 Rust stable。
4. 连接一个可用麦克风和输出设备。
5. 构建 Sidecar：

```powershell
cargo build --release --manifest-path crates/audio-sidecar/Cargo.toml
$env:INTERVIEW_COPILOT_AUDIO_SIDECAR = (Resolve-Path 'crates/audio-sidecar/target/release/interview-audio.exe').Path
npm run dev
```

## 设备与 Probe

1. 启动桌面端，确认 Microphone 和 System Audio 下拉框分别列出输入/输出设备。
2. 确认默认设备自动选中；切换设备后重启应用，确认上次选择恢复。
3. 点击 `Probe 2s`。
4. 只有在 MIC 和 SYSTEM 都有 callback/sample 时，Probe 才能报告 `READY`；否则应报告 `FAILED`，并保留统计数据。
5. 检查 Probe 统计中的 sample rate、channels、callback count、sample count 和 peak。

## 测试 A：仅用户讲话

1. 停止电脑播放音频。
2. 对麦克风讲话 2~3 秒。
3. 预期：`MIC detected`，MIC 电平明显高于阈值；SYSTEM 接近静音且不应被标记 detected。

## 测试 B：仅系统音频

1. 保持安静。
2. 播放 YouTube、腾讯会议或其他系统音频。
3. 预期：`SYSTEM detected`，SYSTEM 电平明显高于阈值；MIC 接近静音且不应被标记 detected。

## 测试 C：同时有声音

1. 同时讲话并播放系统音频。
2. 预期：MIC 和 SYSTEM 都能独立显示电平，并分别进入 detected 状态。

## 恢复测试

1. Sidecar 正常运行时拔出 USB 麦克风，确认状态依次出现 `DEGRADED → RECOVERING`。
2. 恢复设备后确认重新枚举并自动回到 `READY`。
3. 手动点击停止 Sidecar，再拔插设备；确认不会自动重启。
4. 断开蓝牙输出设备，重复以上步骤。

## PCM 验证

正常采集模式下，Sidecar stdout 只输出 PCM，stderr 只输出 JSON event。检查每个完整 packet 为：

```text
640 frames × 2 channels × 2 bytes = 2560 bytes
```

packet 中每个 frame 的顺序必须是 `MIC int16 little-endian` 后接 `SYSTEM int16 little-endian`。
