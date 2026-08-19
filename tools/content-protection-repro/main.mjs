import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outputDirectory = process.env.CONTENT_PROTECTION_REPRO_OUTPUT ?? join(process.cwd(), "artifacts", "content-protection-repro");
const helper = process.env.CAPTURE_HELPER_EXECUTABLE ?? join(process.cwd(), "tools", "capture-helper", "target", "release", "capture-helper.exe");
const protectedMode = process.argv.includes("--protected");

function runHelper(output) {
  return new Promise((resolve) => {
    if (!existsSync(helper)) return resolve({ ok: false, unsupported: true, error: `helper missing: ${helper}` });
    const child = spawn(helper, ["--mode", "display", "--output", output, "--roi", "50,50,250,150"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.once("exit", () => {
      const line = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, unsupported: true, error: text || "no helper result" }); }
    });
  });
}

await app.whenReady();
await mkdir(outputDirectory, { recursive: true });
const normal = new BrowserWindow({ x: 60, y: 60, width: 260, height: 190, show: false, webPreferences: { sandbox: true } });
const layered = new BrowserWindow({ x: 360, y: 60, width: 260, height: 190, show: false, frame: false, transparent: true, alwaysOnTop: true, webPreferences: { sandbox: true } });
const page = (label) => `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#ff00ff;font:700 16px Segoe UI;color:#000;display:grid;place-items:center}</style>${label}`;
await Promise.all([normal.loadURL(`data:text/html,${encodeURIComponent(page("NORMAL WINDOW"))}`), layered.loadURL(`data:text/html,${encodeURIComponent(page("TRANSPARENT ALWAYS-ON-TOP"))}`)]);
normal.setContentProtection(protectedMode);
layered.setContentProtection(protectedMode);
normal.showInactive();
layered.showInactive();
await new Promise((resolve) => setTimeout(resolve, 250));
const capture = await runHelper(join(outputDirectory, protectedMode ? "display-protected.png" : "display-control.png"));
await writeFile(join(outputDirectory, protectedMode ? "protected.json" : "control.json"), JSON.stringify({ protectedMode, normalVisible: normal.isVisible(), layeredVisible: layered.isVisible(), capture }, null, 2));
normal.destroy();
layered.destroy();
app.quit();
