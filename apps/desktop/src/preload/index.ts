import { contextBridge, ipcRenderer } from "electron";
import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";

const api = {
  audio: {
    start: (options?: AudioStartOptions) => ipcRenderer.invoke("audio:start", options),
    stop: () => ipcRenderer.invoke("audio:stop"),
    probe: (options?: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">) => ipcRenderer.invoke("audio:probe", options),
    listDevices: (): Promise<AudioDevices> => ipcRenderer.invoke("audio:list-devices")
  },
  overlay: {
    show: () => ipcRenderer.invoke("overlay:show"),
    toggle: () => ipcRenderer.invoke("overlay:toggle"),
    setMode: (mode: OverlayMode) => ipcRenderer.invoke("overlay:set-mode", mode)
  },
  screenshot: {
    capture: (): Promise<ScreenshotResult> => ipcRenderer.invoke("screenshot:capture")
  },
  session: {
    getState: (): Promise<SessionState> => ipcRenderer.invoke("session:get-state")
  },
  realtime: {
    connect: (options: RealtimeConnectOptions) => ipcRenderer.invoke("realtime:connect", options),
    disconnect: () => ipcRenderer.invoke("realtime:disconnect")
  },
  interview: {
    start: (options: InterviewStartOptions) => ipcRenderer.invoke("interview:start", options) as Promise<string>,
    stop: () => ipcRenderer.invoke("interview:stop") as Promise<void>,
    answerLatest: () => ipcRenderer.invoke("interview:answer-latest") as Promise<void>
  },
  events: {
    onAudio: (listener: (event: AudioSidecarEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AudioSidecarEvent) => listener(payload);
      ipcRenderer.on("audio:event", handler);
      return () => ipcRenderer.removeListener("audio:event", handler);
    },
    onAudioDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("audio:diagnostic", handler);
      return () => ipcRenderer.removeListener("audio:diagnostic", handler);
    },
    onSessionState: (listener: (state: SessionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: SessionState) => listener(state);
      ipcRenderer.on("session:state", handler);
      return () => ipcRenderer.removeListener("session:state", handler);
    },
    onOverlayMode: (listener: (mode: OverlayMode) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: OverlayMode) => listener(mode);
      ipcRenderer.on("overlay:mode", handler);
      return () => ipcRenderer.removeListener("overlay:mode", handler);
    },
    onShortcut: (listener: (shortcut: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, shortcut: string) => listener(shortcut);
      ipcRenderer.on("shortcut", handler);
      return () => ipcRenderer.removeListener("shortcut", handler);
    },
    onAudioProcess: (listener: (state: AudioProcessState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AudioProcessState) => listener(state);
      ipcRenderer.on("audio:process", handler);
      return () => ipcRenderer.removeListener("audio:process", handler);
    },
    onScreenshot: (listener: (result: ScreenshotResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: ScreenshotResult) => listener(result);
      ipcRenderer.on("screenshot:captured", handler);
      return () => ipcRenderer.removeListener("screenshot:captured", handler);
    },
    onScreenshotError: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("screenshot:error", handler);
      return () => ipcRenderer.removeListener("screenshot:error", handler);
    },
    onScreenshotDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("screenshot:diagnostic", handler);
      return () => ipcRenderer.removeListener("screenshot:diagnostic", handler);
    },
    onRealtimeState: (listener: (state: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: string) => listener(state);
      ipcRenderer.on("realtime:state", handler);
      return () => ipcRenderer.removeListener("realtime:state", handler);
    },
    onRealtimeTranscript: (listener: (snapshot: TranscriptSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: TranscriptSnapshot) => listener(snapshot);
      ipcRenderer.on("realtime:transcript", handler);
      return () => ipcRenderer.removeListener("realtime:transcript", handler);
    },
    onRealtimeMessage: (listener: (message: RealtimeServerMessage) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: RealtimeServerMessage) => listener(message);
      ipcRenderer.on("realtime:message", handler);
      return () => ipcRenderer.removeListener("realtime:message", handler);
    },
    onRealtimeDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("realtime:diagnostic", handler);
      return () => ipcRenderer.removeListener("realtime:diagnostic", handler);
    },
    onQuestion: (listener: (event: QuestionEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, question: QuestionEvent) => listener(question);
      ipcRenderer.on("question:event", handler);
      return () => ipcRenderer.removeListener("question:event", handler);
    }
  }
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
