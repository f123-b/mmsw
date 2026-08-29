import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

if (process.platform !== "win32") {
  console.log("NATIVE_MOUSE_SMOKE_RESULT {\"ok\":false,\"result\":\"UNSUPPORTED_ENVIRONMENT\",\"reason\":\"Windows Native mouse smoke requires win32\"}");
  process.exit(0);
}

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);

const userDataDirectory = await mkdtemp(join(tmpdir(), "interview-copilot-native-mouse-"));
const child = spawn(electronExecutable, ["--disable-gpu", "--in-process-gpu", `--user-data-dir=${userDataDirectory}`, "--native-mouse-smoke", desktopDirectory], {
  cwd: desktopDirectory,
  env: { ...process.env, INTERVIEW_COPILOT_DISABLE_GPU: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true", INTERVIEW_COPILOT_TEST_DATA_PATH: userDataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
let result;
const timeout = setTimeout(() => {
  child.kill();
  console.error("Native mouse smoke timed out after 60 seconds");
  void rm(userDataDirectory, { recursive: true, force: true });
  process.exitCode = 1;
}, 60_000);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  output += text;
  process.stdout.write(text);
  const match = output.match(/NATIVE_MOUSE_SMOKE_RESULT (\{[^\r\n]+\})/);
  if (match && !result) {
    try { result = JSON.parse(match[1]); } catch { /* wait for a complete line */ }
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
child.once("error", (error) => { clearTimeout(timeout); void rm(userDataDirectory, { recursive: true, force: true }); console.error(`Unable to start native mouse smoke: ${String(error)}`); process.exitCode = 1; });
child.once("exit", async (code, signal) => {
  clearTimeout(timeout);
  await rm(userDataDirectory, { recursive: true, force: true });
  if (!result) {
    console.error(`Native mouse smoke exited without a result (code=${code}, signal=${signal ?? "none"})`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = (result.result === "PASS" || result.result === "UNSUPPORTED_ENVIRONMENT") && code === 0 ? 0 : 1;
});
