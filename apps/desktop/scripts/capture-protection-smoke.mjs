import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const desktopDirectory = join(repositoryRoot, "apps", "desktop");
const outputDirectory = join(desktopDirectory, "out");
const artifactDirectory = process.env.INTERVIEW_COPILOT_CAPTURE_ARTIFACT_DIR ?? join(repositoryRoot, "artifacts", "capture-protection-v2");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? (process.platform === "win32" ? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe") : join(repositoryRoot, "node_modules", "electron", "dist", "electron"));
const packaged = process.env.ELECTRON_PACKAGED === "true";

for (const output of [join(outputDirectory, "main", "index.js"), join(outputDirectory, "preload", "index.mjs"), join(outputDirectory, "renderer", "index.html")]) {
  if (!existsSync(output)) throw new Error(`Production output is missing: ${output}`);
}
if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
await mkdir(artifactDirectory, { recursive: true });

const userDataDirectory = join(tmpdir(), `interview-copilot-capture-${Date.now()}`);
const args = packaged ? [`--user-data-dir=${userDataDirectory}`, "--capture-protection-smoke"] : [desktopDirectory, `--user-data-dir=${userDataDirectory}`, "--capture-protection-smoke"];
const child = spawn(electronExecutable, args, {
  cwd: desktopDirectory,
  env: { ...process.env, INTERVIEW_COPILOT_CAPTURE_TEST: "1", INTERVIEW_COPILOT_CAPTURE_ARTIFACT_DIR: artifactDirectory, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", ELECTRON_USER_DATA_DIR: userDataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
let result;
const timeout = setTimeout(() => {
  child.kill();
  console.error("Capture protection smoke timed out after 90 seconds");
  process.exitCode = 1;
}, 90_000);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);
  const match = output.match(/CAPTURE_PROTECTION_SMOKE_RESULT (\{[^\r\n]+\})/);
  if (match && !result) {
    try { result = JSON.parse(match[1]); } catch { /* wait for a complete JSON line */ }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
child.once("error", (error) => { clearTimeout(timeout); console.error(`Unable to start capture protection smoke: ${String(error)}`); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  clearTimeout(timeout);
  if (!result) {
    console.error(`Capture protection smoke exited without a result (code=${code}, signal=${signal ?? "none"})`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.ok === true && code === 0 ? 0 : 1;
});
