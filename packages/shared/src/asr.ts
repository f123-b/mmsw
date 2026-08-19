import type { TranscriptSegment } from "@interview-copilot/protocol";

export interface SplitStereoPcmResult {
  mic: Uint8Array;
  system: Uint8Array;
}

/** Split interleaved 16-bit little-endian stereo PCM without changing samples. */
export function splitStereoPcm(packet: Uint8Array): SplitStereoPcmResult {
  if (packet.byteLength % 4 !== 0) throw new Error("Stereo PCM packet must contain complete 16-bit frames");
  const frames = packet.byteLength / 4;
  const mic = new Uint8Array(frames * 2);
  const system = new Uint8Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    mic[frame * 2] = packet[frame * 4];
    mic[frame * 2 + 1] = packet[frame * 4 + 1];
    system[frame * 2] = packet[frame * 4 + 2];
    system[frame * 2 + 1] = packet[frame * 4 + 3];
  }
  return { mic, system };
}

export interface StreamingAsrSocket {
  send(data: Uint8Array): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type StreamingAsrSocketFactory = (options: { url: string; apiKey: string }) => StreamingAsrSocket;

export interface StreamingAsrProvider {
  connect(source: "mic" | "remote", onSegment: (segment: Omit<TranscriptSegment, "id">) => void): Promise<void>;
  sendAudio(pcm: Uint8Array): void;
  close(): void;
}

/** Deepgram's documented Listen WebSocket adapter. It intentionally lives
 * behind a socket factory so the gateway owns headers and API-key handling. */
export class DeepgramStreamingAsrProvider implements StreamingAsrProvider {
  private socket: StreamingAsrSocket | undefined;
  private source: "mic" | "remote" = "remote";
  constructor(private readonly settings: { baseUrl?: string; model: string; apiKey: string }, private readonly socketFactory: StreamingAsrSocketFactory) {}

  async connect(source: "mic" | "remote", onSegment: (segment: Omit<TranscriptSegment, "id">) => void): Promise<void> {
    this.source = source;
    const url = new URL(this.settings.baseUrl || "wss://api.deepgram.com/v1/listen");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("model", this.settings.model || "nova-3");
    const socket = this.socketFactory({ url: url.toString(), apiKey: this.settings.apiKey });
    this.socket = socket;
    socket.onError(() => undefined);
    socket.onMessage((data) => {
      try {
        const message = JSON.parse(data) as { is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> }; start?: number; duration?: number };
        const alternative = message.channel?.alternatives?.[0];
        const text = alternative?.transcript?.trim() ?? "";
        if (!text) return;
        const startMs = Math.max(0, Math.round((message.start ?? 0) * 1_000));
        const endMs = Math.max(startMs, Math.round(((message.start ?? 0) + (message.duration ?? 0)) * 1_000));
        onSegment({ source: this.source, text, startMs, endMs, final: Boolean(message.is_final), ...(alternative?.confidence === undefined ? {} : { confidence: alternative.confidence }) });
      } catch { /* provider keepalive/non-JSON frames are ignored */ }
    });
  }

  sendAudio(pcm: Uint8Array): void { this.socket?.send(pcm); }
  close(): void { this.socket?.close(); this.socket = undefined; }
}

export class StereoAsrChannelRouter {
  constructor(private readonly mic: StreamingAsrProvider, private readonly remote: StreamingAsrProvider) {}

  async connect(onSegment: (segment: Omit<TranscriptSegment, "id">) => void): Promise<void> {
    await Promise.all([this.mic.connect("mic", onSegment), this.remote.connect("remote", onSegment)]);
  }

  sendStereo(packet: Uint8Array): void {
    const channels = splitStereoPcm(packet);
    this.mic.sendAudio(channels.mic);
    this.remote.sendAudio(channels.system);
  }

  close(): void { this.mic.close(); this.remote.close(); }
}
