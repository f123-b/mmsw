import { app, desktopCapturer } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export class ScreenshotManager {
  async capturePrimaryDisplay(): Promise<ScreenshotResult> {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: MAX_DIMENSION, height: MAX_DIMENSION }
    });
    const source = sources[0];
    if (!source) throw new Error("No display source available");

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
    return {
      path,
      mimeType,
      width: size.width,
      height: size.height,
      size: buffer.byteLength,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
    };
  }
}
