import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("UNSUPPORTED_ENVIRONMENT: Windows WASAPI smoke skipped outside Windows");
  process.exit(0);
}

const packageDirectory = process.env.ELECTRON_PACKAGE_DIR ?? join(process.cwd(), "release", "win-unpacked");
const sidecar = process.env.INTERVIEW_COPILOT_AUDIO_SIDECAR ?? join(packageDirectory, "resources", "audio-sidecar", "interview-audio.exe");
if (!existsSync(sidecar)) throw new Error(`SIDECAR_NOT_FOUND: ${sidecar}`);

function run(args, timeoutMs = 7_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(sidecar, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const listing = await run(["--list-devices", "--json"]);
if (listing.code !== 0) throw new Error(`DEVICE_ENUMERATION_FAILED: ${listing.stderr}`);
const devices = JSON.parse(listing.stdout);
console.log(`DEVICE_ENUMERATION: PASS inputs=${devices.inputs.length} outputs=${devices.outputs.length}`);
if (devices.inputs.length === 0 || devices.outputs.length === 0) {
  console.log("REAL_AUDIO_DEVICE: SKIP_NO_INPUT_OR_OUTPUT_DEVICE");
  process.exit(0);
}

const probe = await run(["--probe-only"]);
const events = probe.stderr.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const traces = events.filter((event) => event.type === "audio_probe_trace");
const result = events.find((event) => event.type === "probe_result");
for (const [stage, label] of [["stream_built", "MIC_OPEN"], ["stream_built", "SYSTEM_LOOPBACK_OPEN"], ["first_callback", "FIRST_CALLBACK"]]) {
  const match = traces.find((event) => event.stage === stage && (stage !== "stream_built" || event.channel === (label === "MIC_OPEN" ? "mic" : "system")));
  const channelTimedOut = label === "MIC_OPEN" ? result?.mic?.state === "TIMEOUT" : label === "SYSTEM_LOOPBACK_OPEN" ? result?.system?.state === "TIMEOUT" : result?.mic?.state === "TIMEOUT" || result?.system?.state === "TIMEOUT";
  console.log(`${label}: ${match ? match.details === "timeout" ? "TIMEOUT" : "PASS" : channelTimedOut ? "TIMEOUT" : "NOT_OBSERVED"}`);
}
if (!result) throw new Error(`PROBE_RESULT_FAILED: ${probe.stderr}`);
console.log(`PROBE_RESULT: PASS mic=${result.mic.state ?? (result.mic.streamOk ? "READY" : "UNAVAILABLE")} system=${result.system.state ?? (result.system.streamOk ? "READY" : "UNAVAILABLE")}`);
console.log(`CAPTURE_MODE: ${result.captureMode ?? "NO_AUDIO_CHANNEL_AVAILABLE"}`);
console.log(`PROBE_EXIT_CODE: ${probe.code ?? "unknown"}`);
