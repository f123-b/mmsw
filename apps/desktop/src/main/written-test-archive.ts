import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScreenshotResult } from "./screenshot-manager";
import type { WrittenTestScreenshot } from "@interview-copilot/shared";

export class WrittenTestArchiveService {
  readonly rootDirectory: string;

  constructor(appDataPath: string, private readonly now: () => number = () => Date.now()) {
    this.rootDirectory = join(appDataPath, "InterviewCopilot", "written-tests");
  }

  async archiveScreenshot(sessionId: string, screenshot: Pick<ScreenshotResult, "bytes" | "mimeType" | "width" | "height">, sequence: number, capturedAt = this.now()): Promise<WrittenTestScreenshot> {
    const date = new Date(capturedAt).toISOString().slice(0, 10);
    const directory = join(this.rootDirectory, date, sessionId);
    await mkdir(directory, { recursive: true });
    const extension = screenshot.mimeType === "image/jpeg" ? "jpg" : "png";
    const filePath = join(directory, `${String(sequence).padStart(3, "0")}-original.${extension}`);
    const thumbnailPath = join(directory, `${String(sequence).padStart(3, "0")}-thumb.${extension}`);
    const bytes = Buffer.from(screenshot.bytes);
    await writeFile(filePath, bytes);
    // Keep a separate stable thumbnail artifact. The renderer can downscale it
    // without keeping image bytes in SQLite, and this also works in fixture mode.
    await writeFile(thumbnailPath, bytes);
    return {
      id: `written-screenshot-${capturedAt}-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      filePath,
      thumbnailPath,
      mimeType: screenshot.mimeType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: screenshot.width,
      height: screenshot.height,
      capturedAt
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const matches = await this.findSessionDirectories(sessionId);
    await Promise.all(matches.map((directory) => rm(directory, { recursive: true, force: true })));
  }

  private async findSessionDirectories(sessionId: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const result: string[] = [];
    try {
      for (const date of await readdir(this.rootDirectory)) {
        const directory = join(this.rootDirectory, date, sessionId);
        try { await readdir(directory); result.push(directory); } catch { /* missing directory */ }
      }
    } catch { /* archive has not been created yet */ }
    return result;
  }
}

