import { splitStereoPcm, ProviderError } from "../asr";
import { DeepgramProvider, type DeepgramSocketFactory } from "./providers/deepgram-provider";
import { GatewayProvider } from "./providers/gateway-provider";
import { LocalFunASRProvider } from "./providers/local-funasr-provider";
import type { ASRProvider, ASRProviderFactory } from "./asr-provider";
import type { ASRConfig, ASRProviderSource, ASRSocketFactory, ASRStatus, ASRTranscriptListener } from "./types";

export interface ASRManagerOptions {
  providerFactory?: ASRProviderFactory;
}

/** Coordinates the two logical channels produced by the stereo audio sidecar. */
export class ASRManager {
  private readonly providers = new Map<ASRProviderSource, ASRProvider>();
  private readonly listeners = new Set<ASRTranscriptListener>();
  private config?: ASRConfig;
  private status: ASRStatus = { state: "disconnected", provider: "deepgram", model: "", language: "" };

  constructor(private readonly options: ASRManagerOptions = {}) {}

  async connect(config: ASRConfig): Promise<void> {
    await this.disconnect();
    this.config = { ...config, channels: Math.max(1, config.channels) };
    this.status = { state: "connecting", provider: config.provider, model: config.model, language: config.language };
    const sources: ASRProviderSource[] = config.channels > 1 ? ["mic", "remote"] : ["remote"];
    try {
      await Promise.all(sources.map(async (source) => {
        const provider = (this.options.providerFactory ?? defaultProviderFactory)(this.config!, source);
        provider.onTranscript((segment) => this.listeners.forEach((listener) => listener({ ...segment, source: segment.source ?? source })));
        this.providers.set(source, provider);
        await provider.connect({ ...this.config!, channels: 1 });
      }));
      this.status = { ...this.status, state: "ready" };
    } catch (error) {
      await this.disconnect();
      this.status = { ...this.status, state: "error", lastError: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.config || this.status.state !== "ready") return;
    if (this.config.channels > 1) {
      const channels = splitStereoPcm(pcm);
      this.providers.get("mic")?.sendAudio(channels.mic);
      this.providers.get("remote")?.sendAudio(channels.system);
      return;
    }
    this.providers.get("remote")?.sendAudio(pcm);
  }

  onTranscript(callback: ASRTranscriptListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async finalize(timeoutMs = 1_000): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => {
      const candidate = provider as ASRProvider & { finalize?: (timeoutMs?: number) => Promise<void> };
      return candidate.finalize?.(timeoutMs) ?? Promise.resolve();
    }));
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.disconnect().catch(() => undefined)));
    this.providers.clear();
    this.status = { ...this.status, state: "disconnected" };
  }

  getStatus(): ASRStatus { return { ...this.status }; }
}

export function createDefaultASRProviderFactory(socketFactory: ASRSocketFactory, localSocketFactory: ASRManagerSocketFactory = socketFactory): ASRProviderFactory {
  return (config, source) => {
    if (config.provider === "deepgram") return new DeepgramProvider(socketFactory as unknown as DeepgramSocketFactory, source);
    if (config.provider === "gateway") return new GatewayProvider(socketFactory, source);
    if (config.provider === "funasr-local") return new LocalFunASRProvider(localSocketFactory, source);
    throw new ProviderError("PROVIDER_ERROR", `ASR provider ${config.provider} must use the legacy realtime adapter`, false, source);
  };
}

export type ASRManagerSocketFactory = ASRSocketFactory;

function defaultProviderFactory(_config: ASRConfig, source: ASRProviderSource): ASRProvider {
  throw new ProviderError("CONNECTION_FAILED", `No ASR socket factory configured for ${source}`, false, source);
}
