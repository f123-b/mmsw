import type { AsrProviderType, ProviderSettings } from "./providers";

export const ASR_PRESETS: Record<AsrProviderType, { name: string; baseUrl: string; models: string[]; hint: string }> = {
  qwen: { name: "千问 / 百炼", baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", models: ["qwen3-asr-flash-realtime", "qwen-audio-3.0-asr-flash", "qwen-audio-3.0-asr-flash-streaming", "qwen3-asr-flash", "fun-asr-flash-2026-06-15", "fun-asr-realtime", "paraformer-realtime-v2"], hint: "自动匹配实时和非实时协议；非实时模型按停顿分段识别。请填写与 API Key 地域、业务空间一致的地址。" },
  deepgram: { name: "Deepgram", baseUrl: "wss://api.deepgram.com/v1/listen", models: ["nova-3", "nova-2"], hint: "Listen 实时 WebSocket，支持自定义模型名称。" },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"], hint: "Audio Transcriptions；按停顿提交音频。" },
  groq: { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", models: ["whisper-large-v3-turbo", "whisper-large-v3"], hint: "Whisper 音频转写接口。" },
  siliconflow: { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", models: ["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"], hint: "OpenAI 兼容音频转写；模型名称以账号可用列表为准。" },
  "openai-compatible": { name: "自定义 OpenAI 兼容 / 本地 Whisper", baseUrl: "http://127.0.0.1:8000/v1", models: ["whisper-1"], hint: "支持 /audio/transcriptions 服务，可填写任意模型 ID；本地服务可不填密钥。" },
  elevenlabs: { name: "ElevenLabs Scribe", baseUrl: "https://api.elevenlabs.io/v1/speech-to-text", models: ["scribe_v2", "scribe_v1"], hint: "Scribe 文件转写，使用 ElevenLabs API Key。" },
  azure: { name: "Azure Speech", baseUrl: "https://eastasia.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1", models: ["default"], hint: "将 eastasia 改为资源地域；模型填 default，使用 Speech 资源密钥。必须选择中文或 English。" },
  google: { name: "Google Cloud Speech", baseUrl: "https://speech.googleapis.com/v1/speech:recognize", models: ["default", "latest_short", "latest_long"], hint: "Cloud Speech v1；可填 API Key 或 OAuth Access Token，需开通 Speech API。必须选择具体语言。" },
  assemblyai: { name: "AssemblyAI", baseUrl: "https://api.assemblyai.com/v2", models: ["universal-2", "universal-3-pro"], hint: "上传并查询转写，延迟取决于服务排队；使用 AssemblyAI API Key。" },
  volcengine: { name: "豆包 / 火山引擎", baseUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", models: ["volc.bigasr.auc_turbo"], hint: "录音文件极速版。新版填 API Key；旧版额外填 App ID，密钥处填 Access Token。" },
  baidu: { name: "百度智能云", baseUrl: "https://vop.baidu.com/pro_api", models: ["80001", "1537", "1737", "1637"], hint: "80001 使用 /pro_api；其他模型使用 /server_api。密钥支持 bce-v3 API Key 或 Access Token。" },
  tencent: { name: "腾讯云 ASR", baseUrl: "https://asr.tencentcloudapi.com", models: ["16k_zh", "16k_zh_large", "16k_en"], hint: "一句话识别；密钥处填 SecretKey，下方填 SecretId。" },
  "funasr-local": { name: "FunASR Local", baseUrl: "ws://127.0.0.1:8765", models: ["funasr-nano:q8"], hint: "本地 FunASR 服务自动启动。" },
  "custom-gateway": { name: "自定义语音网关", baseUrl: "ws://127.0.0.1:8787", models: ["default"], hint: "用于讯飞、AWS 或其他供应商的协议转换服务；网关须实现本应用 PCM / asr_final 协议。" }
};

export function usesHttpAsr(settings: Pick<ProviderSettings, "providerType" | "model" | "asrProtocol">): boolean {
  if (settings.asrProtocol === "openai-transcription" || settings.asrProtocol === "qwen-http") return true;
  if (settings.providerType === "qwen") return !["qwen-realtime", "dashscope-streaming"].includes(settings.asrProtocol ?? "auto") && !/(?:realtime|streaming)/i.test(settings.model);
  return Boolean(settings.providerType && !["deepgram", "custom-gateway", "funasr-local"].includes(settings.providerType));
}

export function normalizeAsrSettings(settings: ProviderSettings): ProviderSettings {
  if (settings.providerType === "baidu" && /vop\.baidu\.com/i.test(settings.baseUrl)) return { ...settings, baseUrl: `https://vop.baidu.com/${settings.model === "80001" ? "pro_api" : "server_api"}` };
  if (settings.providerType !== "qwen") return settings;
  const model = settings.model.trim() || ASR_PRESETS.qwen.models[0];
  const url = new URL(settings.baseUrl || ASR_PRESETS.qwen.baseUrl);
  // Preserve regional/workspace hosts, ports and explicit proxy endpoints.
  if (/(?:dashscope[^.]*\.aliyuncs\.com|maas\.aliyuncs\.com)$/i.test(url.hostname) || /^\/api-ws\/v1\/(?:inference|realtime)\/?$/.test(url.pathname)) {
    const http = usesHttpAsr({ ...settings, model });
    url.protocol = http ? "https:" : "wss:";
    url.pathname = http ? "/api/v1/services/aigc/multimodal-generation/generation" : settings.asrProtocol === "qwen-realtime" || settings.asrProtocol !== "dashscope-streaming" && /^qwen3-asr-flash-realtime/i.test(model) ? "/api-ws/v1/realtime" : "/api-ws/v1/inference";
    url.searchParams.delete("model");
  }
  return { ...settings, model, baseUrl: url.toString() };
}
