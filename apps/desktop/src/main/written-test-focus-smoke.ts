import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OverlayManager } from "./overlay-manager";

interface FocusSmokeOptions {
  hoverOnly?: boolean;
  main: BrowserWindow;
  manager: OverlayManager;
  click(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  elementCenter(window: BrowserWindow, selector: string): Promise<{ x: number; y: number }>;
  foreground(): Promise<string>;
  windowAt(point: { x: number; y: number }): Promise<string>;
  cursor(): Promise<{ x: number; y: number }>;
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}`);
}

async function createAnswerWindowFixture(onBlur: () => void) {
  // A separate WinForms process models the external answer application. A
  // BrowserWindow in our own UI thread shares Electron's activation state.
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FocusFixtureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window); }'
    [FocusFixtureDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Written focus test - external answer window'
    $form.TopMost = $true
    $form.StartPosition = 'Manual'
    $form.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Focus test: 1 + 1 = ?'
    $label.SetBounds(40, 35, 400, 40)
    $label.Font = New-Object System.Drawing.Font('Segoe UI', 20)
    $answerTextBox = New-Object System.Windows.Forms.TextBox
    $answerTextBox.SetBounds(40, 100, 260, 32)
    $form.Controls.Add($label)
    $form.Controls.Add($answerTextBox)
    $form.Add_Deactivate({ [Console]::WriteLine('FOCUS_FIXTURE_BLUR') })
    $form.Add_Shown({
      [FocusFixtureDpi]::ShowWindow($form.Handle, 5) | Out-Null
      [FocusFixtureDpi]::SetForegroundWindow($form.Handle) | Out-Null
      $form.Activate()
      $answerTextBox.Focus() | Out-Null
      $point = $answerTextBox.PointToScreen([System.Drawing.Point]::new(20, 12))
      [Console]::WriteLine('FOCUS_FIXTURE_READY ' + (@{ hwnd = $form.Handle.ToInt64().ToString(); x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
    })
    [System.Windows.Forms.Application]::Run($form)
  `;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    const ready = await new Promise<{ hwnd: string; x: number; y: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`External answer fixture did not start: ${output}`)), 10_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`External answer fixture exited: ${code}; ${output}`)); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        output += text;
        for (const _match of text.matchAll(/FOCUS_FIXTURE_BLUR/g)) onBlur();
        const match = output.match(/FOCUS_FIXTURE_READY (\{[^\r\n]+\})/);
        if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
      });
    });
    return { ...ready, destroy: () => child.kill() };
  } catch (error) { child.kill(); throw error; }
}

/** Exercises product IPC and native input in a separate, disposable test profile. */
export async function runWrittenTestFocusSmoke(options: FocusSmokeOptions): Promise<{ ok: true; checks: string[]; screenshots: number }> {
  if (process.platform !== "win32") throw new Error("Native focus verification requires Windows");
  if (!process.env.INTERVIEW_COPILOT_TEST_DATA_PATH) throw new Error("A disposable test data directory is required");
  const { main, manager } = options;
  const checks: string[] = [];
  let screenshots = 0;
  const fixture = {
    inputStatus: "COMPLETE", missingInformation: [],
    problem: { rawText: "用 Python 实现整数相加", canonicalQuestion: "用 Python 实现整数相加", questionType: "PROGRAMMING", requirements: ["返回两个整数的和"], inputs: ["a、b 为整数"], outputs: ["两数之和"], constraints: ["支持负数和零"], formulas: [], requestedArtifacts: { code: true, derivation: true }, confidence: 0.95 },
    answer: { questionType: "PROGRAMMING", finalAnswer: "直接返回 a + b，支持负数和零。", code: { language: "Python", content: "def add(a: int, b: int) -> int:\n    return a + b\n\nassert add(1, 1) == 2\nassert add(-2, 2) == 0" }, steps: [{ title: "读取两个整数", content: "参数 a 和 b 分别接收两个输入值。" }, { title: "计算并返回", content: "相加后直接返回结果，无需额外循环。" }], equations: [], explanation: "示例：输入 1 和 1，返回 2。", complexity: "O(1) 时间，O(1) 额外空间（固定宽度整数）", warnings: [], confidence: 0.9 }
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body || "{}");
    if (input.messages?.some((message: { content?: Array<{ type: string }> }) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))) screenshots += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(fixture) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let blurCount = 0;
  let trackBlur = false;
  let underlay: Awaited<ReturnType<typeof createAnswerWindowFixture>> | undefined;
  const focusEvents: string[] = [];
  const onFocus = (_event: Electron.Event, window: BrowserWindow): void => { focusEvents.push(`focus:${window.id}:${window.getTitle()}`); };
  app.on("browser-window-focus", onFocus);
  const evaluate = <T>(code: string): Promise<T> => main.webContents.executeJavaScript(code) as Promise<T>;
  const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
  try {
    await manager.prepare();
    await evaluate('Array.from(document.querySelectorAll(".sidebar-item")).find(b => b.textContent.includes("笔试解题")).click()');
    await waitUntil(() => evaluate('document.body.innerText.includes("开始笔试")'), "written test entrance");
    await evaluate('document.querySelector("[data-testid=sidebar-settings]").click()');
    await waitUntil(() => evaluate('!!document.querySelector("[data-testid=settings-nav-asr]")'), "settings navigation");
    await evaluate('document.querySelector("[data-testid=settings-nav-asr]").click()');
    await waitUntil(() => evaluate('!!document.querySelector("[data-testid=settings-asr-page]")'), "ASR configuration");
    assert(await evaluate('document.querySelector("[data-testid=settings-asr-page] select").options.length === 15 && !!document.querySelector("#asr-model-options")'), "ASR provider templates or custom model input missing");
    checks.push("written test entrance and all 15 ASR configuration templates rendered");
    await evaluate(`(async () => {
      const api = window.interviewCopilot;
      const profile = await api.profiles.save({ name: "Focus smoke fixture" });
      window.__focusSmokeProfileId = profile.id;
      await api.settings.update("llm", { baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "local-focus-test", model: "focus-fixture", visionModel: "focus-fixture", timeoutMs: 10000, maxRetries: 0 });
      await api.overlay.setPreferences({ writtenTest: { focusProtection: true, layoutPreset: "single_reader" }, behavior: { interactionMode: "interactive" } });
    })()`);
    await evaluate('window.interviewCopilot.writtenTest.start({ profileId: window.__focusSmokeProfileId, answerMode: "NORMAL" })');
    assert(!main.isFocusable() && !main.isVisible(), "Main window did not become protected");
    for (const window of manager.currentWindows) assert(!window.isFocusable(), "An overlay can receive focus");
    // Enter the practice session first, then select the answer window as a user
    // would. Hiding the launcher itself is an intentional foreground transition.
    underlay = await createAnswerWindowFixture(() => { if (trackBlur) { blurCount += 1; focusEvents.push("answer-window-blur"); } });
    manager.assertOverlayZOrder("focus-smoke-fixture");
    await options.click(underlay.x, underlay.y);
    const originalWindow = await options.foreground();
    const originalForeground = originalWindow.match(/hwnd=(\d+)/)?.[1];
    assert(originalForeground === underlay.hwnd, `Answer window was not the native foreground: ${originalWindow}`);
    trackBlur = true;
    const assertPreserved = async (label: string): Promise<void> => {
      const currentWindow = await options.foreground();
      assert(currentWindow.match(/hwnd=(\d+)/)?.[1] === originalForeground, `${label}: native foreground changed from [${originalWindow}] to [${currentWindow}]; events=${JSON.stringify(focusEvents)}`);
      assert(blurCount === 0, `${label}: answer window received ${blurCount} blur event(s)`);
      checks.push(label);
      process.stdout.write(`WRITTEN_FOCUS_CHECK ${label}\n`);
    };
    const reader = manager.currentQuestionWindow!;
    const control = reader;
    assert(!manager.currentControlWindow?.isVisible() && !manager.currentAnswerWindow?.isVisible(), "Written controls must share the reader window");
    await waitUntil(() => reader.webContents.executeJavaScript('Boolean(document.querySelector(".written-workspace-footer"))'), "integrated reader ready");
    assert(await reader.webContents.executeJavaScript('(() => { const b = document.querySelector(".written-camera-control"); return b && !b.hasAttribute("title") && getComputedStyle(b).cursor === "default" && !document.querySelector(".written-answer-tabs"); })()'), "Screenshot tooltip, hand cursor or answer tabs remain");
    checks.push("integrated reader has arrow cursor, no tooltip and no answer tabs");
    assert(await reader.webContents.executeJavaScript('Array.from(document.querySelectorAll(".written-workspace-footer button")).every((b, i) => !b.hasAttribute("title") && getComputedStyle(b).cursor === "default" && b.getAttribute("data-hover-delay-ms") === (i === 4 ? "1500" : "800"))'), "Footer hover delay, cursor or tooltip configuration is incorrect");
    checks.push("all footer controls use arrow cursors with 800 ms dwell, exit uses 1500 ms");
    await assertPreserved("running session keeps main and overlays non-focusable");

    let secondInstanceObserved = false;
    const observeSecondInstance = (): void => { secondInstanceObserved = true; };
    app.once("second-instance", observeSecondInstance);
    const userDataSwitch = process.argv.find((argument) => argument.startsWith("--user-data-dir="));
    const second = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), ...(userDataSwitch ? [userDataSwitch] : [])], { env: process.env, windowsHide: true, stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { second.kill(); reject(new Error("Second instance did not exit")); }, 8_000);
        second.once("error", (error) => { clearTimeout(timeout); reject(error); });
        second.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Second instance exit: ${code}`)); });
      });
      assert(secondInstanceObserved && !main.isVisible(), "Duplicate launch was not blocked");
      await assertPreserved("duplicate launch remains hidden");
    } finally { app.removeListener("second-instance", observeSecondInstance); }

    const nativeHover = async (label: string, delayMs: number): Promise<void> => {
      await options.move(underlay!.x, underlay!.y);
      const selector = `button[aria-label="${label}"]`;
      await waitUntil(() => reader.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-disabled") === "false"`), `${label} enabled`);
      await reader.webContents.executeJavaScript(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        window.__footerHover = { label: ${JSON.stringify(label)}, enteredAt: null, firedAfterMs: null };
        button.addEventListener("pointerenter", () => { window.__footerHover.enteredAt = performance.now(); }, { once: true });
        window.__footerHoverCleanup?.();
        window.__footerHoverCleanup = window.interviewCopilot.events.onWrittenTestState(state => {
          const metric = window.__footerHover;
          const fired = metric.label === "退出笔试" ? !state.running : metric.label === "新题" ? state.nextScreenshotRelation === "NEW_QUESTION" : state.screenshotStatus === "CAPTURING";
          if (fired && metric.enteredAt !== null && metric.firedAfterMs === null) metric.firedAfterMs = performance.now() - metric.enteredAt;
        });
      })()`);
      const point = await options.elementCenter(reader, selector);
      const enteredAt = Date.now();
      await options.move(point.x, point.y);
      if (label === "退出笔试") await waitUntil(async () => !(await evaluate<{ running: boolean }>("window.interviewCopilot.writtenTest.getState()")).running, `${label} hover action`, delayMs + 5000);
      else await waitUntil(() => reader.webContents.executeJavaScript('window.__footerHover.firedAfterMs !== null'), `${label} hover action`, delayMs + 5000);
      const metric = label === "退出笔试" ? { label, firedAfterMs: Date.now() - enteredAt } : await reader.webContents.executeJavaScript('window.__footerHover') as { firedAfterMs: number };
      assert(metric.firedAfterMs >= delayMs - 10, `${label} fired early: ${JSON.stringify(metric)}`);
      process.stdout.write(`WRITTEN_FOOTER_HOVER ${JSON.stringify(metric)}\n`);
    };
    if (!options.hoverOnly) {
      await evaluate('window.interviewCopilot.overlay.setPreferences({ writtenTest: { focusProtection: false } })');
      await waitUntil(() => main.isFocusable(), "protection off");
      await assertPreserved("changing focus protection does not activate main");
      await evaluate('window.interviewCopilot.overlay.setPreferences({ writtenTest: { focusProtection: true } })');
      await waitUntil(() => !main.isFocusable(), "protection on");
    }

    await waitUntil(() => control.webContents.executeJavaScript('document.querySelector(".written-camera-control")?.getAttribute("aria-disabled") === "false"'), "hover screenshot control ready");
    await control.webContents.executeJavaScript(`(() => {
      window.__writtenHover = { enteredAt: null, captureAfterMs: null, clicks: 0 };
      document.addEventListener("pointerover", (event) => {
        if (event.target.closest(".written-camera-control") && window.__writtenHover.enteredAt === null) window.__writtenHover.enteredAt = performance.now();
      });
      document.addEventListener("click", () => { window.__writtenHover.clicks += 1; });
      window.interviewCopilot.events.onWrittenTestState((state) => {
        if (state.screenshotStatus === "CAPTURING" && window.__writtenHover.captureAfterMs === null && window.__writtenHover.enteredAt !== null) window.__writtenHover.captureAfterMs = performance.now() - window.__writtenHover.enteredAt;
      });
    })()`);
    const hoverPoint = await options.elementCenter(control, ".written-camera-control");
    await options.move(hoverPoint.x, hoverPoint.y);
    await waitUntil(async () => (await evaluate<{ screenshotStatus: string }>("window.interviewCopilot.writtenTest.getState()")).screenshotStatus === "SUCCESS", "screenshot and local fixture answer", 15_000);
    const hoverTiming = await control.webContents.executeJavaScript("window.__writtenHover") as { captureAfterMs: number | null; clicks: number };
    process.stdout.write(`WRITTEN_HOVER_TIMING ${JSON.stringify(hoverTiming)}\n`);
    assert(hoverTiming.clicks === 0 && hoverTiming.captureAfterMs !== null && hoverTiming.captureAfterMs >= 790, `Screenshot did not wait 0.8 seconds of hover without a click: ${JSON.stringify(hoverTiming)}`);
    assert(screenshots === 1, "The hover did not produce exactly one screenshot request");
    await assertPreserved("0.8-second native screenshot hover and answer preserve focus");
    assert(await reader.webContents.executeJavaScript('!!document.querySelector(".written-workspace-answer pre code") && document.querySelectorAll(".written-workspace-answer li").length === 2 && !!document.querySelector(".written-final-answer")'), "Code, answer or steps are not displayed together");
    checks.push("answer, code and steps appear together without switching");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert(screenshots === 1, "A stationary pointer repeated the screenshot after the answer completed");
    checks.push("stationary hover triggers only once");
    await options.move(underlay.x, underlay.y);
    await options.move(hoverPoint.x, hoverPoint.y);
    await waitUntil(async () => screenshots === 2 && (await evaluate<{ screenshotStatus: string }>("window.interviewCopilot.writtenTest.getState()")).screenshotStatus === "SUCCESS", "fresh hover after leaving", 15_000);
    await assertPreserved("leaving and re-entering rearms hover without focus changes");
    assert(await reader.webContents.executeJavaScript('document.querySelectorAll(".written-workspace-footer button").length === 5'), "Integrated footer controls are missing");
    if (!options.hoverOnly) {
      await nativeHover("补图", 800);
      await waitUntil(async () => screenshots === 3 && (await evaluate<{ screenshotStatus: string }>("window.interviewCopilot.writtenTest.getState()")).screenshotStatus === "SUCCESS", "native continuation capture");
      await assertPreserved("hover continuation capture preserves focus");
      await nativeHover("重拍", 800);
      await waitUntil(async () => screenshots === 4 && (await evaluate<{ screenshotStatus: string }>("window.interviewCopilot.writtenTest.getState()")).screenshotStatus === "SUCCESS", "hover replacement capture");
      await assertPreserved("hover replacement capture preserves focus");
      await evaluate('window.interviewCopilot.writtenTest.setNextScreenshotRelation("CONTINUATION")');
      await nativeHover("新题", 800);
      await assertPreserved("hover new question preserves focus");
    }

    await evaluate("window.interviewCopilot.overlay.requestEndInterview()");
    await waitUntil(() => Boolean(manager.currentTransientWindow?.isVisible()), "end confirmation visible");
    assert(!manager.currentTransientWindow!.isFocusable(), "Confirmation can receive focus");
    await assertPreserved("end confirmation preserves focus");
    await evaluate("window.interviewCopilot.overlay.cancelEndInterview()");
    const artifacts = process.env.INTERVIEW_FOCUS_ARTIFACT_DIR;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "written-focus-reader.png"), (await reader.webContents.capturePage()).toPNG());
      
    }
    await nativeHover("退出笔试", 1500);
    await waitUntil(() => main.isFocusable() && main.isVisible() && main.isFocused(), "main window restored after stopping");
    checks.push("1.5-second hover exits and restores main window focus");
    return { ok: true, checks, screenshots };
  } finally {
    app.removeListener("browser-window-focus", onFocus);
    underlay?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
