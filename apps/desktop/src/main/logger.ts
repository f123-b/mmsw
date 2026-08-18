import { appendFileSync, existsSync, renameSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;
const SECRET_PATTERNS = [/(api[_-]?key|authorization|token|ticket|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, /Bearer\s+[A-Za-z0-9._-]+/gi];

export function redactSecrets(input: string): string {
  return input.replace(SECRET_PATTERNS[0], "$1=[REDACTED]").replace(SECRET_PATTERNS[1], "Bearer [REDACTED]");
}

export class SafeLogger {
  private readonly filePath: string;

  constructor(directory: string, private readonly scope: "app" | "audio" | "realtime") {
    mkdirSync(directory, { recursive: true });
    this.filePath = join(directory, `${scope}.log`);
  }

  info(message: string, fields: Record<string, unknown> = {}): void { this.write("INFO", message, fields); }
  warn(message: string, fields: Record<string, unknown> = {}): void { this.write("WARN", message, fields); }
  error(message: string, fields: Record<string, unknown> = {}): void { this.write("ERROR", message, fields); }

  private write(level: string, message: string, fields: Record<string, unknown>): void {
    const line = redactSecrets(JSON.stringify({ timestamp: new Date().toISOString(), level, scope: this.scope, message, fields })) + "\n";
    if (existsSync(this.filePath) && statSync(this.filePath).size + Buffer.byteLength(line) > MAX_LOG_BYTES) this.rotate();
    appendFileSync(this.filePath, line, { encoding: "utf8" });
  }

  private rotate(): void {
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const oldPath = `${this.filePath}.${index}`;
      const nextPath = `${this.filePath}.${index + 1}`;
      if (existsSync(oldPath)) {
        if (existsSync(nextPath)) unlinkSync(nextPath);
        renameSync(oldPath, nextPath);
      }
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}
