import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
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
const smokeArguments = ["--production-smoke", ...(visualSmoke ? ["--visual-smoke"] : [])];
const electronArguments = packaged ? smokeArguments : [desktopDirectory, ...smokeArguments];

const exitCode = await new Promise((resolve) => {
  const child = spawn(electronExecutable, electronArguments, {
    cwd: desktopDirectory,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
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
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
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
    resolve(smokeResult.ok === true && code === 0 ? 0 : 1);
  });
});

process.exitCode = exitCode;
