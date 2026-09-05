import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const appPath = join(import.meta.dirname, "..", "release", "win-unpacked", "有招.exe");
if (!existsSync(appPath)) throw new Error(`Packaged app is missing: ${appPath}`);

const port = 9333;
const child = spawn(appPath, [`--remote-debugging-port=${port}`], { windowsHide: false, stdio: "ignore" });

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      const target = pages.find((page) => page.type === "page" && page.title === "有招");
      if (target?.webSocketDebuggerUrl) return target;
    } catch { /* app is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the 有招 renderer target");
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const id = Math.floor(Math.random() * 1_000_000);
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP evaluation timed out: ${expression}`)), 5_000);
    socket.on("message", (data) => {
      const payload = JSON.parse(String(data));
      if (payload.id !== id) return;
      clearTimeout(timeout);
      resolve(payload.result?.result?.value);
    });
    socket.once("error", reject);
  });
  socket.close();
  return result;
}

try {
  const target = await waitForTarget();
  const apiPresent = await evaluate(target.webSocketDebuggerUrl, "Boolean(window.interviewCopilot?.windowControls)");
  const dragRegions = await evaluate(target.webSocketDebuggerUrl, `(() => {
    const strip = document.querySelector('.window-drag-strip');
    const lights = document.querySelector('.window-traffic-lights');
    const red = document.querySelector('.traffic-close');
    return {
      stripRegion: getComputedStyle(strip).webkitAppRegion,
      stripWidth: strip.getBoundingClientRect().width,
      lightsRegion: getComputedStyle(lights).webkitAppRegion,
      closeRegion: getComputedStyle(red).webkitAppRegion
    };
  })()`);
  const maximized = await evaluate(target.webSocketDebuggerUrl, "window.interviewCopilot.windowControls.toggleMaximize()");
  const restored = await evaluate(target.webSocketDebuggerUrl, "window.interviewCopilot.windowControls.toggleMaximize()");
  const minimized = await evaluate(target.webSocketDebuggerUrl, "window.interviewCopilot.windowControls.minimize()");
  const closed = await evaluate(target.webSocketDebuggerUrl, "window.interviewCopilot.windowControls.close()").catch(() => true);
  const stableDragRegions = dragRegions?.stripRegion === "drag" && dragRegions.stripWidth >= 300 && dragRegions.lightsRegion === "no-drag" && dragRegions.closeRegion === "no-drag";
  if (!apiPresent || !stableDragRegions || maximized !== true || restored !== false || minimized !== true || closed !== true) {
    throw new Error(`Window controls failed: ${JSON.stringify({ apiPresent, stableDragRegions, dragRegions, maximized, restored, minimized, closed })}`);
  }
  console.log("WINDOW_CONTROLS_SMOKE_RESULT", JSON.stringify({ ok: true, apiPresent, stableDragRegions, dragRegions, maximized, restored, minimized, closed }));
} finally {
  if (!child.killed) child.kill();
}
