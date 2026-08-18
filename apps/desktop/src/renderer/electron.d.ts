import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";

declare global {
  interface Window {
    interviewCopilot: {
      audio: {
        start(options?: AudioStartOptions): Promise<void>;
        stop(): Promise<void>;
        probe(options?: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): Promise<void>;
        listDevices(): Promise<AudioDevices>;
      };
      overlay: {
        show(): Promise<void>;
        toggle(): Promise<void>;
        setMode(mode: OverlayMode): Promise<void>;
      };
      screenshot: {
        capture(): Promise<ScreenshotResult>;
      };
      session: {
        getState(): Promise<SessionState>;
      };
      realtime: {
        connect(options: RealtimeConnectOptions): Promise<boolean>;
        disconnect(): Promise<boolean>;
      };
      events: {
        onAudio(listener: (event: AudioSidecarEvent) => void): () => void;
        onAudioDiagnostic(listener: (message: string) => void): () => void;
        onSessionState(listener: (state: SessionState) => void): () => void;
        onOverlayMode(listener: (mode: OverlayMode) => void): () => void;
        onShortcut(listener: (shortcut: string) => void): () => void;
        onAudioProcess(listener: (state: AudioProcessState) => void): () => void;
        onScreenshot(listener: (result: ScreenshotResult) => void): () => void;
        onScreenshotError(listener: (message: string) => void): () => void;
        onScreenshotDiagnostic(listener: (message: string) => void): () => void;
        onRealtimeState(listener: (state: string) => void): () => void;
        onRealtimeTranscript(listener: (snapshot: TranscriptSnapshot) => void): () => void;
        onRealtimeMessage(listener: (message: RealtimeServerMessage) => void): () => void;
        onRealtimeDiagnostic(listener: (message: string) => void): () => void;
      };
    };
  }
}

export {};
