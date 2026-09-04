import { createHash, createHmac, randomUUID } from "node:crypto";
import { normalizeAsrSettings, ProviderError, type ProviderSettings, type StreamingAsrProvider, type StreamingAsrErrorListener } from "@interview-copilot/shared";
import type { TranscriptSegment } from "@interview-copilot/protocol";

type FetchLike = typeof fetch;
type Segment = Omit<TranscriptSegment, "id">;
export class HttpAsrError extends Error {
  constructor(message: string, readonly status = 400, readonly providerCode?: string) { super(message); }
}

export function pcmToWav(pcm: Uint8Array): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); wav.set(pcm, 44);
  return wav;
}

function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if (!url.pathname.replace(/\/$/, "").endsWith(path)) url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
  return url.toString();
}
function speechText(payload: any): string | undefined {
  if (typeof payload?.text === "string") return payload.text;
  if (typeof payload?.output?.text === "string") return payload.output.text;
  const sentence = payload?.output?.sentence ?? payload?.output?.output?.sentence;
  if (typeof sentence?.text === "string") return sentence.text;
  const content = payload?.output?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c.text ?? "").join("");
  return undefined;
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});

/** All requests use the same wire format in connection tests and live capture. */
export async function transcribePcm(input: ProviderSettings, pcm: Uint8Array, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<string> {
  const settings = normalizeAsrSettings(input);
  const provider = settings.providerType ?? "openai-compatible";
  const model = settings.model;
  const lang = settings.language === "multi" ? undefined : settings.language?.split("-")[0] ?? "zh";
  const wav = pcmToWav(pcm);
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = settings.baseUrl;
  let body: BodyInit;
  let json: unknown;
  const key = settings.apiKey;
  const request = async (target: string, init: RequestInit): Promise<any> => {
    const response = await fetchImpl(target, { ...init, signal });
    let value: any;
    try { value = await response.json(); } catch { throw new HttpAsrError(`语音接口返回了无效 JSON（HTTP ${response.status}）`, response.ok ? 502 : response.status); }
    const volcStatus = response.headers.get("X-Api-Status-Code");
    if (!response.ok || value.error || value.code && value.code !== "200" && value.code !== 200 || value.err_no || value.Response?.Error || volcStatus && volcStatus !== "20000000") {
      const detail = String(value.error?.message ?? value.error ?? value.message ?? value.err_msg ?? value.Response?.Error?.Message ?? response.headers.get("X-Api-Message") ?? `HTTP ${response.status}`);
      throw new HttpAsrError(detail.replaceAll(key || "__no_key__", "[redacted]").slice(0, 300), response.ok ? 400 : response.status, String(value.err_no ?? value.code ?? value.Response?.Error?.Code ?? ""));
    }
    return value;
  };
  if (settings.asrProtocol === "openai-transcription" || ["openai", "groq", "siliconflow", "openai-compatible"].includes(provider)) {
    url = endpoint(url, "audio/transcriptions");
    if (key) headers.Authorization = `Bearer ${key}`;
    const form = new FormData(); form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav"); form.set("model", model); form.set("response_format", "json"); if (lang) form.set("language", lang);
    body = form;
  } else if (provider === "qwen" || settings.asrProtocol === "qwen-http") {
    if (/filetrans|^paraformer(?:-|$)|^fun-asr(?:-mtl)?$/i.test(model)) throw new HttpAsrError("此模型要求公网文件异步转写，请选择 Flash / Realtime / Streaming 模型，或使用自定义网关上传文件。");
    headers.Authorization = `Bearer ${key}`;
    headers["X-DashScope-SSE"] = "disable";
    const data = `data:audio/wav;base64,${wav.toString("base64")}`;
    const modern = /^(?:qwen-audio-3\.0|fun-asr-flash)/i.test(model);
    const content = modern ? [{ type: "input_audio", input_audio: { data } }] : [{ audio: data }];
    const parameters = modern
      ? { format: "wav", sample_rate: "16000", ...(lang ? { language_hints: [lang] } : {}) }
      : { asr_options: { enable_itn: true, ...(lang ? { language: lang } : {}) } };
    json = { model, input: { messages: [{ role: "user", content }] }, parameters };
    body = "";
  } else if (provider === "elevenlabs") {
    headers["xi-api-key"] = key;
    const form = new FormData(); form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav"); form.set("model_id", model); form.set("tag_audio_events", "false"); if (lang) form.set("language_code", lang);
    body = form;
  } else if (provider === "azure") {
    if (!lang) throw new HttpAsrError("Azure 短语音接口需要指定中文或 English。");
    const parsed = new URL(url); parsed.searchParams.set("language", settings.language ?? "zh-CN"); parsed.searchParams.set("format", "simple"); url = parsed.toString();
    headers["Ocp-Apim-Subscription-Key"] = key; headers["Content-Type"] = "audio/wav; codecs=audio/pcm; samplerate=16000";
    body = new Uint8Array(wav);
  } else if (provider === "google") {
    if (!lang) throw new HttpAsrError("Google Speech v1 需要指定中文或 English。");
    if (key.startsWith("AIza")) headers["X-Goog-Api-Key"] = key; else headers.Authorization = `Bearer ${key}`;
    json = { config: { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode: settings.language === "zh-CN" ? "cmn-Hans-CN" : settings.language ?? "cmn-Hans-CN", model, enableAutomaticPunctuation: true }, audio: { content: Buffer.from(pcm).toString("base64") } }; body = "";
  } else if (provider === "volcengine") {
    if (settings.asrAppId) { headers["X-Api-App-Key"] = settings.asrAppId; headers["X-Api-Access-Key"] = key; } else headers["X-Api-Key"] = key;
    headers["X-Api-Resource-Id"] = model; headers["X-Api-Request-Id"] = randomUUID(); headers["X-Api-Sequence"] = "-1";
    json = { user: { uid: "interview-copilot" }, audio: { data: wav.toString("base64") }, request: { model_name: "bigmodel", enable_itn: true, enable_punc: true } }; body = "";
  } else if (provider === "baidu") {
    if (key.startsWith("bce-v3/")) headers.Authorization = `Bearer ${key}`;
    json = { format: "pcm", rate: 16000, channel: 1, cuid: "interview-copilot", dev_pid: Number(model), ...(key.startsWith("bce-v3/") ? {} : { token: key }), speech: Buffer.from(pcm).toString("base64"), len: pcm.byteLength }; body = "";
  } else if (provider === "tencent") {
    if (!settings.asrAppId) throw new HttpAsrError("请填写腾讯云 SecretId，密钥处填写 SecretKey。");
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    body = JSON.stringify({ ProjectId: 0, SubServiceType: 2, EngSerViceType: model, SourceType: 1, VoiceFormat: "wav", Data: wav.toString("base64"), DataLen: wav.length, UsrAudioKey: randomUUID() });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const hmac = (secret: string | Buffer, value: string) => createHmac("sha256", secret).update(value).digest();
    const host = new URL(url).host;
    const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${hash(body)}`;
    const scope = `${date}/asr/tc3_request`;
    const signature = hmac(hmac(hmac(hmac(`TC3${key}`, date), "asr"), "tc3_request"), `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString("hex");
    headers.Authorization = `TC3-HMAC-SHA256 Credential=${settings.asrAppId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
    Object.assign(headers, { "Content-Type": "application/json; charset=utf-8", "X-TC-Action": "SentenceRecognition", "X-TC-Version": "2019-06-14", "X-TC-Timestamp": String(timestamp) });
  } else if (provider === "assemblyai") {
    const auth = { authorization: key };
    const upload = await request(endpoint(url, "upload"), { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: new Uint8Array(wav) });
    if (typeof upload.upload_url !== "string") throw new HttpAsrError("AssemblyAI 缺少音频上传地址", 502);
    let transcript = await request(endpoint(url, "transcript"), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ audio_url: upload.upload_url, speech_models: [model], ...(lang ? { language_code: lang } : { language_detection: true }) }) });
    if (!transcript.id) throw new HttpAsrError("AssemblyAI 缺少任务 ID", 502);
    while (transcript.status !== "completed") { if (transcript.status === "error") throw new HttpAsrError(String(transcript.error ?? "AssemblyAI 转写失败")); await delay(500, signal); transcript = await request(endpoint(url, `transcript/${encodeURIComponent(transcript.id)}`), { headers: auth }); }
    if (typeof transcript.text !== "string") throw new HttpAsrError("AssemblyAI 缺少转写文本", 502);
    return transcript.text.trim();
  } else throw new HttpAsrError(`未实现的 HTTP ASR 协议：${provider}`);
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  const payload = await request(url, { method: "POST", headers, body });
  let text: string | undefined;
  if (provider === "azure") {
    if (payload.RecognitionStatus === "NoMatch" || payload.RecognitionStatus === "InitialSilenceTimeout") return "";
    if (payload.RecognitionStatus !== "Success") throw new HttpAsrError(`Azure 识别失败：${payload.RecognitionStatus ?? "未知响应"}`, 502);
    text = payload.DisplayText;
  } else if (provider === "google") text = Array.isArray(payload.results) ? payload.results.map((r: any) => r.alternatives?.[0]?.transcript ?? "").join(" ") : Object.keys(payload).length === 0 ? "" : undefined;
  else if (provider === "volcengine") text = payload.result?.text;
  else if (provider === "baidu") text = Array.isArray(payload.result) ? payload.result.join("") : undefined;
  else if (provider === "tencent") text = payload.Response?.Result;
  else text = speechText(payload);
  if (text === undefined) throw new HttpAsrError("语音接口缺少转写文本，请检查模型和协议", 502);
  return text.trim();
}

/** Ordered, bounded silence-delimited uploads; raw audio never enters the renderer. */
export class HttpStreamingAsrProvider implements StreamingAsrProvider {
  private onSegment?: (segment: Segment) => void;
  private onError?: StreamingAsrErrorListener;
  private source: "mic" | "remote" = "remote";
  private buffers: Buffer[] = [];
  private bytes = 0;
  private speech = false;
  private silenceMs = 0;
  private timeMs = 0;
  private startMs = 0;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private controller?: AbortController;
  constructor(private readonly settings: ProviderSettings, private readonly fetchImpl: FetchLike = fetch) {}
  async connect(source: "mic" | "remote", onSegment: (segment: Segment) => void, onError?: StreamingAsrErrorListener): Promise<void> {
    this.close(); this.source = source; this.onSegment = onSegment; this.onError = onError; this.controller = new AbortController(); this.timeMs = 0; this.pending = 0; this.queue = Promise.resolve();
  }
  sendAudio(pcm: Uint8Array): void {
    if (!this.controller || this.controller.signal.aborted) return;
    const ms = pcm.length / 32;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0; for (let i = 0; i + 1 < pcm.length; i += 2) sum += view.getInt16(i, true) ** 2;
    const voiced = Math.sqrt(sum / Math.max(1, pcm.length / 2)) > 160;
    if (!this.bytes) this.startMs = this.timeMs;
    this.timeMs += ms; this.buffers.push(Buffer.from(pcm)); this.bytes += pcm.length;
    if (voiced) { this.speech = true; this.silenceMs = 0; } else this.silenceMs += ms;
    if (!this.speech && this.bytes > 6400) { this.buffers = [Buffer.concat(this.buffers).subarray(-6400)]; this.bytes = 6400; this.startMs = this.timeMs - 200; }
    if (this.speech && (this.silenceMs >= 640 || this.bytes >= 12 * 32000)) this.flush();
  }
  private flush(): void {
    if (!this.speech || !this.bytes || !this.controller) return;
    const pcm = Buffer.concat(this.buffers); const startMs = this.startMs; const endMs = this.timeMs; const controller = this.controller;
    this.buffers = []; this.bytes = 0; this.speech = false; this.silenceMs = 0;
    if (this.pending >= 8) { this.onError?.(new ProviderError("PROVIDER_ERROR", "语音识别积压，请切换较快的模型或实时协议", true, this.source)); return; }
    this.pending++;
    this.queue = this.queue.then(async () => {
      if (controller.signal.aborted) return;
      const timeout = AbortSignal.timeout(Math.max(15000, this.settings.timeoutMs));
      try {
        const text = await transcribePcm(this.settings, pcm, AbortSignal.any([controller.signal, timeout]), this.fetchImpl);
        if (text && !controller.signal.aborted) this.onSegment?.({ source: this.source, text, final: true, startMs, endMs, confidence: 0.95, endpoint: true });
      } catch (error) {
        if (!controller.signal.aborted) this.onError?.(new ProviderError(error instanceof HttpAsrError && [401, 403].includes(error.status) ? "AUTH_FAILED" : "PROVIDER_ERROR", error instanceof Error ? error.message : "语音识别失败", !(error instanceof HttpAsrError && [400, 401, 403, 404].includes(error.status)), this.source));
      } finally { if (this.controller === controller) this.pending--; }
    });
  }
  async finalize(timeoutMs = 15000): Promise<void> {
    this.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.queue, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); }
  }
  close(): void { this.controller?.abort(); this.controller = undefined; this.buffers = []; this.bytes = 0; this.speech = false; this.silenceMs = 0; }
}
