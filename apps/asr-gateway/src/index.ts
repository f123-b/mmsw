import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { clientControlMessageSchema } from "@interview-copilot/protocol";
import { DeepgramStreamingAsrProvider, ProviderError, StereoAsrChannelRouter, type StreamingAsrSocket } from "@interview-copilot/shared";

const host = process.env.INTERVIEW_COPILOT_ASR_HOST ?? "127.0.0.1";
const port = Number(process.env.INTERVIEW_COPILOT_ASR_PORT ?? 8787);
const gatewayToken = process.env.INTERVIEW_COPILOT_GATEWAY_TOKEN ?? "";
const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? "";
const deepgramUrl = process.env.DEEPGRAM_URL ?? "wss://api.deepgram.com/v1/listen";

class WsDeepgramSocket implements StreamingAsrSocket {
  constructor(private readonly socket: WebSocket) {}

  waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Deepgram WebSocket closed before OPEN")); };
      const cleanup = () => {
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  send(data: Uint8Array | string): void { this.socket.send(data); }
  close(): void { if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close(); }
  onMessage(listener: (data: string) => void): void { this.socket.on("message", (data: RawData) => listener(data.toString())); }
  onError(listener: (error: Error) => void): void { this.socket.on("error", listener); }
  onClose(listener: (error?: Error) => void): void { this.socket.on("close", () => listener()); }
}

function createRouter(model: string | undefined, language: "zh-CN" | "en-US" | "multi" | undefined): StereoAsrChannelRouter {
  const createProvider = () => new DeepgramStreamingAsrProvider({ baseUrl: deepgramUrl, model: model || "nova-3", language: language || "zh-CN", apiKey: deepgramApiKey }, ({ url, apiKey }) => new WsDeepgramSocket(new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } })));
  return new StereoAsrChannelRouter(createProvider(), createProvider());
}

function runtimeError(socket: WebSocket, code: "WS_AUTH_FAILED" | "ASR_FAILED", message: string, recoverable = code !== "WS_AUTH_FAILED"): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "runtime_error", code, message, recoverable }));
}

function ticketFromRequest(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined;
  try { return new URL(requestUrl, "ws://localhost").searchParams.get("ticket") ?? undefined; } catch { return undefined; }
}

function handleConnection(socket: WebSocket): void {
  const sessionId = randomUUID();
  let ready = false;
  let router: StereoAsrChannelRouter | undefined;
  socket.send(JSON.stringify({ type: "connection_ready", sessionId, serverTime: Date.now() }));
  socket.on("message", async (raw: RawData, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const control = clientControlMessageSchema.parse(JSON.parse(raw.toString()));
        if (control.type !== "client_ready") return;
        if (!deepgramApiKey) {
          runtimeError(socket, "ASR_FAILED", "Custom Gateway 未配置 Deepgram API Key", false);
          socket.close();
          return;
        }
        router = createRouter(control.model, control.language);
        await router.connect((segment) => {
          const id = `${segment.source}-${segment.startMs}-${segment.endMs}-${segment.final ? "final" : "partial"}-${segment.text}`;
          const message = { type: segment.final ? "asr_final" : "asr_partial", segment: { ...segment, id } };
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        }, (error) => {
          runtimeError(socket, error.code === "AUTH_FAILED" ? "WS_AUTH_FAILED" : "ASR_FAILED", error.message, error.recoverable);
        });
        ready = true;
        socket.send(JSON.stringify({ type: "asr_status", source: "mic", state: "listening" }));
        socket.send(JSON.stringify({ type: "asr_status", source: "remote", state: "listening" }));
      } catch (error) {
        const code = error instanceof ProviderError && error.code === "AUTH_FAILED" ? "WS_AUTH_FAILED" : "ASR_FAILED";
        runtimeError(socket, code, error instanceof Error ? error.message : String(error), code !== "WS_AUTH_FAILED");
        socket.close();
      }
      return;
    }
    if (ready && router) {
      try { router.sendStereo(new Uint8Array(raw as Buffer)); }
      catch (error) { runtimeError(socket, "ASR_FAILED", String(error)); }
    }
  });
  socket.on("close", () => router?.close());
  socket.on("error", () => router?.close());
}

const server = new WebSocketServer({ host, port, verifyClient: gatewayToken ? (info, done) => {
  const ticket = ticketFromRequest(info.req.url);
  done(ticket === gatewayToken, 401, "Gateway token rejected");
} : undefined });
server.on("connection", handleConnection);
server.on("listening", () => process.stdout.write(`Interview Copilot ASR gateway listening on ws://${host}:${port}\n`));
