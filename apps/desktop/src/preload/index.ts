import { contextBridge, ipcRenderer } from "electron";
import type { AudioStartOptions } from "../main/audio-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";

const api = {
  audio: {
    start: (options?: AudioStartOptions) => ipcRenderer.invoke("audio:start", options),
    stop: () => ipcRenderer.invoke("audio:stop"),
    probe: () => ipcRenderer.invoke("audio:probe"),
    listDevices: (): Promise<AudioDevices> => ipcRenderer.invoke("audio:list-devices")
  },
  overlay: {
    show: () => ipcRenderer.invoke("overlay:show"),
    toggle: () => ipcRenderer.invoke("overlay:toggle"),
    setMode: (mode: OverlayMode) => ipcRenderer.invoke("overlay:set-mode", mode)
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
    }
  }
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
