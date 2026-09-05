import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const desktopDirectory = join(repositoryRoot, "apps", "desktop");
const outputDirectory = join(desktopDirectory, "out");
const requiredOutputs = [
  join(outputDirectory, "main", "index.js"),
  join(outputDirectory, "preload", "index.mjs"),
  join(outputDirectory, "renderer", "index.html")
];

for (const output of requiredOutputs) {
  if (!existsSync(output)) throw new Error(`Production output is missing: ${output}`);
}

const compiledMain = readFileSync(requiredOutputs[0], "utf8");
if (compiledMain.includes("preload/index.js")) throw new Error("Compiled main still references preload/index.js");

const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? (process.platform === "win32"
  ? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe")
  : join(repositoryRoot, "node_modules", "electron", "dist", "electron"));
if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
const packaged = process.env.ELECTRON_PACKAGED === "true";
const visualSmoke = process.env.UI_VISUAL_SMOKE === "true";
// CI/desktop sandboxes can expose a broken GPU process. The smoke validates
// window/renderer behavior, so keep it deterministic with software compositing.
const smokeUserDataDirectory = join(tmpdir(), `interview-copilot-smoke-${process.pid}`);
// Keep smoke isolated from a developer's real database. Large local history
// files can exhaust sql.js during the renderer's parallel startup queries and
// make visual capture look like a window/compositor hang.
const smokeDataDirectory = join(tmpdir(), `interview-copilot-smoke-data-${process.pid}`);
const smokeArguments = ["--production-smoke", ...(visualSmoke ? ["--visual-smoke"] : [])];
const electronSwitches = [
  ...(process.env.UI_HARDWARE_CAPTURE === "true" ? [] : ["--disable-gpu", "--in-process-gpu"]),
  `--user-data-dir=${smokeUserDataDirectory}`
];
const electronArguments = packaged ? [...electronSwitches, ...smokeArguments] : [...electronSwitches, desktopDirectory, ...smokeArguments];

const exitCode = await new Promise((resolve) => {
  const child = spawn(electronExecutable, electronArguments, {
    cwd: desktopDirectory,
    env: { ...process.env, INTERVIEW_COPILOT_DISABLE_GPU: "1", INTERVIEW_COPILOT_TEST_DATA_PATH: smokeDataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  let stderr = "";
  let smokeResult;
  const timeout = setTimeout(() => {
    child.kill();
    console.error("Production smoke timed out after 60 seconds");
    resolve(1);
  }, 60_000);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
    const match = output.match(/PRODUCTION_SMOKE_RESULT (\{[^\r\n]+\})/);
    if (match && !smokeResult) {
      try { smokeResult = JSON.parse(match[1]); } catch { /* wait for the complete line */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(String(chunk)); });
  child.once("error", (error) => {
    clearTimeout(timeout);
    console.error(`Unable to start production Electron: ${String(error)}`);
    resolve(1);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (!smokeResult) {
      console.error(`Production smoke exited without a result (code=${code}, signal=${signal ?? "none"})`);
      resolve(1);
      return;
    }
    const runtimeFailure = /Error occurred in handler|out of memory|Uncaught Exception/iu.test(`${output}\n${stderr}`);
    if (runtimeFailure) console.error("Production smoke encountered a runtime error, including during shutdown");
    resolve(smokeResult.ok === true && code === 0 && !runtimeFailure ? 0 : 1);
  });
});

process.exitCode = exitCode;
