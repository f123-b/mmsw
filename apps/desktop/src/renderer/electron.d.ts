import type { AudioStartOptions } from "../main/audio-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";

declare global {
  interface Window {
    interviewCopilot: {
      audio: {
        start(options?: AudioStartOptions): Promise<void>;
        stop(): Promise<void>;
        probe(): Promise<void>;
        listDevices(): Promise<AudioDevices>;
      };
      overlay: {
        show(): Promise<void>;
        toggle(): Promise<void>;
        setMode(mode: OverlayMode): Promise<void>;
      };
      session: {
        getState(): Promise<SessionState>;
      };
      events: {
        onAudio(listener: (event: AudioSidecarEvent) => void): () => void;
        onAudioDiagnostic(listener: (message: string) => void): () => void;
        onSessionState(listener: (state: SessionState) => void): () => void;
        onOverlayMode(listener: (mode: OverlayMode) => void): () => void;
        onShortcut(listener: (shortcut: string) => void): () => void;
      };
    };
  }
}

export {};
