import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { clientControlMessageSchema } from "@interview-copilot/protocol";
import { DeepgramStreamingAsrProvider, StereoAsrChannelRouter, type StreamingAsrSocket } from "@interview-copilot/shared";

const port = Number(process.env.INTERVIEW_COPILOT_ASR_PORT ?? 8787);
const gatewayToken = process.env.INTERVIEW_COPILOT_GATEWAY_TOKEN ?? "";
const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? "";
const deepgramModel = process.env.DEEPGRAM_MODEL ?? "nova-3";
const deepgramUrl = process.env.DEEPGRAM_URL ?? "wss://api.deepgram.com/v1/listen";

class WsDeepgramSocket implements StreamingAsrSocket {
  constructor(private readonly socket: WebSocket) {}
  send(data: Uint8Array): void { this.socket.send(data); }
  close(): void { this.socket.close(); }
  onMessage(listener: (data: string) => void): void { this.socket.on("message", (data: RawData) => listener(data.toString())); }
  onError(listener: (error: Error) => void): void { this.socket.on("error", listener); }
}

function createDeepgramProvider() {
  return new DeepgramStreamingAsrProvider({ baseUrl: deepgramUrl, model: deepgramModel, apiKey: deepgramApiKey }, ({ url, apiKey }) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });
    return new WsDeepgramSocket(socket);
  });
}

function runtimeError(socket: WebSocket, code: "WS_AUTH_FAILED" | "ASR_FAILED", message: string): void {
  socket.send(JSON.stringify({ type: "runtime_error", code, message, recoverable: code !== "WS_AUTH_FAILED" }));
}

function handleConnection(socket: WebSocket): void {
  const sessionId = randomUUID();
  let ready = false;
  const router = new StereoAsrChannelRouter(createDeepgramProvider(), createDeepgramProvider());
  socket.send(JSON.stringify({ type: "connection_ready", sessionId, serverTime: Date.now() }));
  socket.on("message", async (raw: RawData, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const control = clientControlMessageSchema.parse(JSON.parse(raw.toString()));
        if (control.type !== "client_ready") return;
        if (gatewayToken && control.gatewayToken !== gatewayToken) {
          runtimeError(socket, "WS_AUTH_FAILED", "Gateway token rejected");
          socket.close();
          return;
        }
        if (!deepgramApiKey) {
          runtimeError(socket, "ASR_FAILED", "DEEPGRAM_API_KEY is not configured on the trusted gateway");
          socket.close();
          return;
        }
        await router.connect((segment) => {
          const message = { type: segment.final ? "asr_final" : "asr_partial", segment: { ...segment, id: `${segment.source}-${Date.now()}-${randomUUID().slice(0, 8)}` } };
          socket.send(JSON.stringify(message));
        });
        ready = true;
        socket.send(JSON.stringify({ type: "asr_status", source: "mic", state: "listening" }));
        socket.send(JSON.stringify({ type: "asr_status", source: "remote", state: "listening" }));
      } catch (error) {
        runtimeError(socket, "WS_AUTH_FAILED", "Invalid gateway control message");
        socket.close();
      }
      return;
    }
    if (ready) {
      try { router.sendStereo(new Uint8Array(raw as Buffer)); }
      catch (error) { runtimeError(socket, "ASR_FAILED", String(error)); }
    }
  });
  socket.on("close", () => router.close());
  socket.on("error", () => router.close());
}

const server = new WebSocketServer({ port });
server.on("connection", handleConnection);
server.on("listening", () => process.stdout.write(`Interview Copilot ASR gateway listening on ws://127.0.0.1:${port}\n`));
