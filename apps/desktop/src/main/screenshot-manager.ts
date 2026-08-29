import { app, desktopCapturer, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { selectPrimaryScreenSource, type ScreenSourceLike } from "./screen-source-selection";
import { isScreenshotExpired } from "./screenshot-cleanup";
import type { ScreenshotImage } from "@interview-copilot/shared";

export { selectPrimaryScreenSource } from "./screen-source-selection";
export type { ScreenSourceLike } from "./screen-source-selection";

const MAX_DIMENSION = 1_280;
const MAX_PNG_BYTES = 2 * 1024 * 1024;

export interface ScreenshotResult extends ScreenshotImage {
  path: string;
  size: number;
  dataUrl: string;
}

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function mapScreenshotRegion(region: ScreenshotRegion, sourceSize: { width: number; height: number }, displaySize = sourceSize): ScreenshotRegion {
  const x = Math.max(0, Math.min(sourceSize.width - 1, Math.floor((region.x / Math.max(1, displaySize.width)) * sourceSize.width)));
  const y = Math.max(0, Math.min(sourceSize.height - 1, Math.floor((region.y / Math.max(1, displaySize.height)) * sourceSize.height)));
  const width = Math.max(1, Math.min(sourceSize.width - x, Math.floor((region.width / Math.max(1, displaySize.width)) * sourceSize.width)));
  const height = Math.max(1, Math.min(sourceSize.height - y, Math.floor((region.height / Math.max(1, displaySize.height)) * sourceSize.height)));
  return { x, y, width, height };
}

export interface ScreenshotManagerOptions {
  onDiagnostic?: (message: string) => void;
  getOverlayWindow?: () => { isDestroyed(): boolean; isVisible(): boolean; hide(): void; showInactive(): void } | undefined;
  shouldUseInternalFallback?: (result: ScreenshotResult) => boolean | Promise<boolean>;
  captureRendererFallback?: () => Promise<ScreenshotResult>;
  captureFixture?: () => Promise<ScreenshotResult>;
}

const MINIMAL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function createScreenshotFixtureResult(path = `fixture://${Date.now()}.png`): ScreenshotResult {
  const bytes = new Uint8Array(Buffer.from(MINIMAL_PNG_BASE64, "base64"));
  return { path, mimeType: "image/png", bytes, width: 1, height: 1, size: bytes.byteLength, dataUrl: `data:image/png;base64,${MINIMAL_PNG_BASE64}` };
}

export class ScreenshotManager {
  constructor(private readonly options: ScreenshotManagerOptions = {}) {}

  async capturePrimaryDisplay(signal?: AbortSignal, region?: ScreenshotRegion): Promise<ScreenshotResult> {
    if (this.options.captureFixture) return await this.withAbort(this.options.captureFixture(), signal);
    let result: ScreenshotResult;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const directCapture = this.capturePrimaryDisplayDirect(region);
      try {
        result = await this.withAbort(Promise.race([
          directCapture,
          new Promise<ScreenshotResult>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Display capture timed out")), 2_000);
          })
        ]), signal);
      } finally {
        if (timeout) clearTimeout(timeout);
        void directCapture.catch(() => undefined);
      }
    } catch (error) {
      const fallback = this.options.captureRendererFallback;
      if (!fallback) throw error;
      this.options.onDiagnostic?.(`DISPLAY_CAPTURE_UNAVAILABLE_USING_RENDERER_TEST_SOURCE: ${String(error)}`);
      result = await this.withAbort(fallback(), signal);
    }
    if (signal?.aborted) throw this.abortError();
    if (await this.options.shouldUseInternalFallback?.(result)) {
      await this.cleanup(result);
      return await this.withAbort(this.captureWithInternalFallback(region), signal);
    }
    return result;
  }

  private abortError(): Error {
    const error = new Error("Screenshot capture aborted");
    error.name = "AbortError";
    return error;
  }

  private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await promise;
    if (signal.aborted) {
      void promise.catch(() => undefined);
      throw this.abortError();
    }
    let onAbort: (() => void) | undefined;
    const abort = new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(this.abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, abort]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async capturePrimaryDisplayDirect(region?: ScreenshotRegion): Promise<ScreenshotResult> {
    await this.cleanupExpired();
    const primaryDisplay = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: MAX_DIMENSION, height: MAX_DIMENSION }
    });
    const source = selectPrimaryScreenSource(sources, primaryDisplay.id);
    if (!source) throw new Error("No display source available");
    if (String(source.display_id ?? "") !== String(primaryDisplay.id)) {
      this.options.onDiagnostic?.(
        `Primary display source ${primaryDisplay.id} was not found; falling back to ${source.id}`
      );
    }

    return this.saveSource(source, region, primaryDisplay.bounds);
  }

  private async captureWithInternalFallback(region?: ScreenshotRegion): Promise<ScreenshotResult> {
    const overlay = this.options.getOverlayWindow?.();
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return await this.capturePrimaryDisplayDirect(region);
    const started = Date.now();
    overlay.hide();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      this.options.onDiagnostic?.("INTERNAL_SCREENSHOT_FALLBACK_ACTIVE");
      return await this.capturePrimaryDisplayDirect(region);
    } finally {
      overlay.showInactive();
      if (Date.now() - started > 200) this.options.onDiagnostic?.("INTERNAL_SCREENSHOT_FALLBACK_SLOW");
    }
  }

  async captureWindow(sourceId: string): Promise<ScreenshotResult> {
    await this.cleanupExpired();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: MAX_DIMENSION, height: MAX_DIMENSION }
    });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error(`Window capture source is unavailable: ${sourceId}`);
    return this.saveSource(source);
  }

  private async saveSource(source: Electron.DesktopCapturerSource, region?: ScreenshotRegion, displayBounds?: Electron.Rectangle): Promise<ScreenshotResult> {
    let image = source.thumbnail;
    if (region) {
      const original = image.getSize();
      image = image.crop(mapScreenshotRegion(region, original, { width: displayBounds?.width ?? original.width, height: displayBounds?.height ?? original.height }));
    }
    const original = image.getSize();
    const scale = Math.min(1, MAX_DIMENSION / Math.max(original.width, original.height));
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(original.width * scale)),
        height: Math.max(1, Math.round(original.height * scale))
      });
    }

    let mimeType: ScreenshotResult["mimeType"] = "image/png";
    let buffer = image.toPNG();
    if (buffer.byteLength > MAX_PNG_BYTES) {
      mimeType = "image/jpeg";
      buffer = image.toJPEG(85);
    }

    const directory = join(app.getPath("temp"), "interview-copilot", "screenshots");
    await mkdir(directory, { recursive: true });
    const extension = mimeType === "image/png" ? "png" : "jpg";
    const safeSourceId = source.id.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const path = join(directory, `${Date.now()}-${safeSourceId}.${extension}`);
    await writeFile(path, buffer);
    const size = image.getSize();
    const result = {
      path,
      mimeType,
      bytes: new Uint8Array(buffer),
      width: size.width,
      height: size.height,
      size: buffer.byteLength,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
    };
    const timer = setTimeout(() => { void this.cleanup(result); }, 15 * 60_000);
    timer.unref?.();
    return result;
  }

  async cleanup(result: Pick<ScreenshotResult, "path">): Promise<void> {
    try { await unlink(result.path); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") this.options.onDiagnostic?.(`Screenshot cleanup failed: ${code || "unknown"}`);
    }
  }

  private async cleanupExpired(): Promise<void> {
    try {
      const directory = join(app.getPath("temp"), "interview-copilot", "screenshots");
      for (const filename of await readdir(directory)) {
        const path = join(directory, filename);
        try { if (isScreenshotExpired((await stat(path)).mtimeMs, Date.now())) await unlink(path); } catch { /* a concurrent cleanup is harmless */ }
      }
    } catch { /* the directory may not exist on first run */ }
  }
}
