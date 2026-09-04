import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "../..");
const hoverOnly = process.argv.includes("--hover");
const artifacts = resolve(process.env.INTERVIEW_FOCUS_ARTIFACT_DIR ?? join(repositoryRoot, "artifacts", hoverOnly ? "written-hover-smoke" : "written-focus-smoke"));
const dataDirectory = await mkdtemp(join(tmpdir(), "interview-written-focus-"));
const executable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const packaged = process.env.ELECTRON_PACKAGED === "true";
await mkdir(artifacts, { recursive: true });
let output = "";
let result;
let timedOut = false;
try {
  const child = spawn(executable, ["--disable-gpu", "--in-process-gpu", `--user-data-dir=${join(dataDirectory, "chromium")}`, ...(packaged ? [] : [desktopDirectory]), "--written-focus-smoke", ...(hoverOnly ? ["--written-hover-only"] : [])], {
    cwd: desktopDirectory,
    env: { ...process.env, INTERVIEW_COPILOT_DISABLE_GPU: "1", INTERVIEW_COPILOT_TEST_DATA_PATH: dataDirectory, INTERVIEW_FOCUS_ARTIFACT_DIR: artifacts },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const consume = (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
    const match = output.match(/WRITTEN_FOCUS_SMOKE_RESULT (\{[^\r\n]+\})/);
    if (match) result = JSON.parse(match[1]);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
  });
  await writeFile(join(artifacts, "native-focus.log"), output, "utf8");
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ ...result, exitCode: code, timedOut, packaged, executable }, null, 2), "utf8");
  process.exitCode = result?.ok === true && code === 0 && !timedOut ? 0 : 1;
} finally {
  // Only remove the temporary profile created by this invocation.
  const checkedPath = resolve(dataDirectory);
  if (dirname(checkedPath) === resolve(tmpdir()) && basename(checkedPath).startsWith("interview-written-focus-")) await rm(checkedPath, { recursive: true, force: true });
}
