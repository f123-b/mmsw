import { app, desktopCapturer, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { selectPrimaryScreenSource, type ScreenSourceLike } from "./screen-source-selection";
import { isScreenshotExpired } from "./screenshot-cleanup";

export { selectPrimaryScreenSource } from "./screen-source-selection";
export type { ScreenSourceLike } from "./screen-source-selection";

const MAX_DIMENSION = 1_280;
const MAX_PNG_BYTES = 2 * 1024 * 1024;

export interface ScreenshotResult {
  path: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  size: number;
  dataUrl: string;
}

export interface ScreenshotManagerOptions {
  onDiagnostic?: (message: string) => void;
}

export class ScreenshotManager {
  constructor(private readonly options: ScreenshotManagerOptions = {}) {}

  async capturePrimaryDisplay(): Promise<ScreenshotResult> {
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

    let image = source.thumbnail;
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
    const path = join(directory, `${Date.now()}-${source.id}.${extension}`);
    await writeFile(path, buffer);
    const size = image.getSize();
    const result = {
      path,
      mimeType,
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
