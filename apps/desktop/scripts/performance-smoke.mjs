import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const desktopDirectory = join(repositoryRoot, "apps", "desktop");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);

const userDataDirectory = join(tmpdir(), `interview-copilot-performance-${process.pid}`);
const dataDirectory = join(tmpdir(), `interview-copilot-performance-data-${process.pid}`);
await mkdir(dataDirectory, { recursive: true });
const child = spawn(electronExecutable, ["--disable-gpu", "--in-process-gpu", `--user-data-dir=${userDataDirectory}`, desktopDirectory, "--performance-smoke"], {
  cwd: desktopDirectory,
  env: {
    ...process.env,
    INTERVIEW_COPILOT_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    INTERVIEW_COPILOT_CAPTURE_TEST: "1",
    INTERVIEW_COPILOT_SCREENSHOT_FIXTURE: "1",
    INTERVIEW_COPILOT_TEST_DATA_PATH: dataDirectory
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
let result;
const timeout = setTimeout(() => {
  child.kill();
  console.error("Performance smoke timed out after 60 seconds");
  process.exitCode = 1;
}, 60_000);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);
  const match = output.match(/PERFORMANCE_SMOKE_RESULT (\{[^\r\n]+\})/);
  if (match && !result) {
    try { result = JSON.parse(match[1]); } catch { /* wait for the complete line */ }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
child.once("error", (error) => { clearTimeout(timeout); console.error(`Unable to start performance smoke: ${String(error)}`); process.exitCode = 1; });
child.once("exit", async (code, signal) => {
  clearTimeout(timeout);
  await Promise.all([
    rm(userDataDirectory, { recursive: true, force: true }),
    rm(dataDirectory, { recursive: true, force: true })
  ]);
  if (!result) {
    console.error(`Performance smoke exited without a result (code=${code}, signal=${signal ?? "none"})`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.ok === true && code === 0 ? 0 : 1;
});
