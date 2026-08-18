import { contextBridge, ipcRenderer } from "electron";
import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
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
    onPcm: (listener: (chunk: Uint8Array) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => listener(chunk);
      ipcRenderer.on("audio:pcm", handler);
      return () => ipcRenderer.removeListener("audio:pcm", handler);
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
    }
  }
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
