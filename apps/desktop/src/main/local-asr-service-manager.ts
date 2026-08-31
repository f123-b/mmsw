import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { terminateGracefully } from "./managed-process";

export interface LocalAsrServiceOptions {
  resolveServiceRoot: () => string | undefined;
  resolveResourcesPath?: () => string | undefined;
  pythonPath?: string;
  openAsrPath?: string;
  resolveOpenAsrPath?: () => string | undefined;
  resolveOpenAsrHome?: () => string | undefined;
  resolveModelPack?: (model: string) => string | undefined;
  upstreamUrl?: string;
  startupTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface LocalAsrStartOptions {
  webSocketUrl?: string;
  model?: string;
  upstreamUrl?: string;
}

export type LocalAsrServiceState = "stopped" | "starting" | "ready" | "error";

export interface LocalAsrHealthCheck {
  checkedAt: number;
  overall: "ready" | "degraded" | "not_ready";
  state: LocalAsrServiceState;
  serviceRoot: { ok: boolean; path?: string; reason: string };
  python: { ok: boolean; command: string; reason: string };
  openasr: { ok: boolean; command: string; reason: string };
  venv: { ok: boolean; path?: string; reason: string };
  dependencies: { ok: boolean; requirementsPath?: string; reason: string };
  model: { ok: boolean; path?: string; reason: string };
  facadePort: { ok: boolean; host: string; port: number; reason: string };
  backendPort: { ok: boolean; host: string; port: number; reason: string };
  runtime: { backendPid?: number; facadePid?: number; backendRunning: boolean; facadeRunning: boolean };
}

type Endpoint = {
  host: string;
  port: number;
};

const DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8765";
const DEFAULT_UPSTREAM_URL = "http://127.0.0.1:8080";
const DEFAULT_MODEL = "funasr-nano:q8";

function endpointFromUrl(value: string, defaultPort: number): Endpoint {
  const url = new URL(value);
  const port = Number(url.port || defaultPort);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid local ASR endpoint: ${value}`);
  return { host: url.hostname, port };
}

function isTcpReachable(endpoint: Endpoint, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForTcp(endpoint: Endpoint, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpReachable(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local ASR service did not become ready at ${endpoint.host}:${endpoint.port}`);
}

function firstExistingPath(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function probeExecutable(command: string, args: string[], cwd: string, timeoutMs = 2_000): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const finish = async (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateGracefully(child, { gracefulTimeoutMs: 250, forceTimeoutMs: 250 });
      resolve({ ok, reason });
    };
    const timer = setTimeout(() => { void finish(false, `probe timeout: ${command}`); }, timeoutMs);
    child.once("error", (error) => { void finish(false, error.message); });
    child.once("exit", (code) => { void finish(code === 0, code === 0 ? "ok" : `exit code ${code ?? "unknown"}`); });
  });
}

export class LocalAsrServiceManager {
  private backendProcess: ChildProcess | undefined;
  private facadeProcess: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private lifecycleVersion = 0;
  private state: LocalAsrServiceState = "stopped";
  private lastError: string | undefined;

  constructor(private readonly options: LocalAsrServiceOptions) {}

  getStatus(): { state: LocalAsrServiceState; error?: string } {
    return { state: this.state, error: this.lastError };
  }

  /**
   * Read-only preflight for the local ASR stack. It deliberately reports each
   * layer separately so a packaged build can distinguish missing Python,
   * dependencies, OpenASR/model assets, facade and port failures.
   */
  async getHealthCheck(startOptions: LocalAsrStartOptions = {}): Promise<LocalAsrHealthCheck> {
    const serviceRoot = this.options.resolveServiceRoot();
    const serviceRootExists = Boolean(serviceRoot && existsSync(serviceRoot));
    const serverScript = serviceRoot ? join(serviceRoot, "server.py") : undefined;
    const serviceRootCheck = {
      ok: Boolean(serverScript && existsSync(serverScript)),
      ...(serviceRoot ? { path: serviceRoot } : {}),
      reason: !serviceRoot ? "local-asr-service service root not resolved" : !serviceRootExists ? "service root not found" : !serverScript || !existsSync(serverScript) ? "server.py not found" : "server.py found"
    };
    const python = this.resolvePython(serviceRoot ?? process.cwd());
    const pythonProbe = await probeExecutable(python.command, [...python.args, "-c", "print('mmsw-python-ok')"], serviceRoot ?? process.cwd());
    const pythonPath = python.command.includes("\\") || python.command.includes("/") ? python.command : undefined;
    const venvPath = firstExistingPath(serviceRoot ? [join(serviceRoot, ".venv", "Scripts", "python.exe"), join(serviceRoot, ".venv", "bin", "python")] : []);
    const requirementsPath = serviceRoot ? join(serviceRoot, "requirements.txt") : undefined;
    const dependencyProbe = serviceRootCheck.ok && pythonProbe.ok && requirementsPath && existsSync(requirementsPath)
      ? await probeExecutable(python.command, [...python.args, "-c", "import httpx, websockets"], serviceRoot ?? process.cwd())
      : { ok: false, reason: !serviceRootCheck.ok ? serviceRootCheck.reason : !requirementsPath || !existsSync(requirementsPath) ? "requirements.txt not found" : `python unavailable: ${pythonProbe.reason}` };
    const openAsrCommand = this.resolveOpenAsrCommand();
    const openAsrProbe = await probeExecutable(openAsrCommand, ["--version"], serviceRoot ?? process.cwd());
    const model = startOptions.model || DEFAULT_MODEL;
    const modelPath = this.options.resolveModelPack?.(model);
    const webSocketEndpoint = endpointFromUrl(startOptions.webSocketUrl || DEFAULT_WEBSOCKET_URL, 8765);
    const upstreamEndpoint = endpointFromUrl(startOptions.upstreamUrl || this.options.upstreamUrl || DEFAULT_UPSTREAM_URL, 8080);
    const facadeReachable = await isTcpReachable(webSocketEndpoint);
    const backendReachable = await isTcpReachable(upstreamEndpoint);
    const runtime = {
      ...(this.backendProcess?.pid ? { backendPid: this.backendProcess.pid } : {}),
      ...(this.facadeProcess?.pid ? { facadePid: this.facadeProcess.pid } : {}),
      backendRunning: Boolean(this.backendProcess && this.backendProcess.exitCode === null),
      facadeRunning: Boolean(this.facadeProcess && this.facadeProcess.exitCode === null)
    };
    const openAsr = { ok: openAsrProbe.ok || backendReachable, command: openAsrCommand, reason: openAsrProbe.ok ? openAsrProbe.reason : backendReachable ? "backend port already reachable" : openAsrProbe.reason };
    const modelCheck = { ok: Boolean(modelPath) || backendReachable, ...(modelPath ? { path: modelPath } : {}), reason: modelPath ? `${model} model pack found` : backendReachable ? "backend already reachable" : `${model} model pack not found` };
    const checks = [serviceRootCheck.ok, pythonProbe.ok, Boolean(venvPath), dependencyProbe.ok, openAsr.ok, modelCheck.ok, facadeReachable || runtime.facadeRunning, backendReachable || runtime.backendRunning];
    const overall = checks.every(Boolean) ? "ready" : checks.some(Boolean) ? "degraded" : "not_ready";
    return {
      checkedAt: Date.now(),
      overall,
      state: this.state,
      serviceRoot: serviceRootCheck,
      python: { ok: pythonProbe.ok, ...(pythonPath ? { command: pythonPath } : { command: python.command }), reason: pythonProbe.reason },
      openasr: openAsr,
      venv: { ok: Boolean(venvPath), ...(venvPath ? { path: venvPath } : {}), reason: venvPath ? "venv found" : serviceRootCheck.ok ? "venv not found" : "venv not checked because service root is unavailable" },
      dependencies: { ok: dependencyProbe.ok, ...(requirementsPath ? { requirementsPath } : {}), reason: dependencyProbe.reason },
      model: modelCheck,
      facadePort: { ok: facadeReachable, host: webSocketEndpoint.host, port: webSocketEndpoint.port, reason: facadeReachable ? "reachable" : "not reachable" },
      backendPort: { ok: backendReachable, host: upstreamEndpoint.host, port: upstreamEndpoint.port, reason: backendReachable ? "reachable" : "not reachable" },
      runtime
    };
  }

  async ensureRunning(startOptions: LocalAsrStartOptions = {}): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const lifecycleVersion = this.lifecycleVersion;
    this.startPromise = this.start(startOptions, lifecycleVersion).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.lifecycleVersion += 1;
    this.startPromise = undefined;
    const processes = [this.facadeProcess, this.backendProcess].filter((process): process is ChildProcess => Boolean(process));
    await Promise.all(processes.map((process) => this.terminate(process)));
    if (this.facadeProcess && processes.includes(this.facadeProcess)) this.facadeProcess = undefined;
    if (this.backendProcess && processes.includes(this.backendProcess)) this.backendProcess = undefined;
    this.state = "stopped";
    this.lastError = undefined;
  }

  private async start(startOptions: LocalAsrStartOptions, lifecycleVersion: number): Promise<void> {
    this.state = "starting";
    this.lastError = undefined;
    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const webSocketUrl = startOptions.webSocketUrl || DEFAULT_WEBSOCKET_URL;
    const upstreamUrl = startOptions.upstreamUrl || this.options.upstreamUrl || DEFAULT_UPSTREAM_URL;
    const webSocketEndpoint = endpointFromUrl(webSocketUrl, 8765);
    const upstreamEndpoint = endpointFromUrl(upstreamUrl, 8080);
    const model = startOptions.model || DEFAULT_MODEL;
    const ownedProcesses: ChildProcess[] = [];
    const cancelIfStale = async (): Promise<boolean> => {
      if (lifecycleVersion === this.lifecycleVersion) return false;
      await this.stopProcesses(ownedProcesses);
      if (lifecycleVersion === this.lifecycleVersion) {
        this.state = "stopped";
        this.lastError = undefined;
      }
      return true;
    };

    try {
      if (await cancelIfStale()) return;
      const backendReady = await isTcpReachable(upstreamEndpoint);
      if (await cancelIfStale()) return;
      if (!backendReady) {
        const process = this.spawnOpenAsr(model);
        ownedProcesses.push(process);
        if (await cancelIfStale()) return;
        this.backendProcess = process;
        await waitForTcp(upstreamEndpoint, timeoutMs);
      }

      if (await cancelIfStale()) return;
      const facadeReady = await isTcpReachable(webSocketEndpoint);
      if (await cancelIfStale()) return;
      if (!facadeReady) {
        const process = this.spawnFacade({
          serviceRoot: this.options.resolveServiceRoot(),
          host: webSocketEndpoint.host,
          port: webSocketEndpoint.port,
          model,
          upstreamUrl
        });
        ownedProcesses.push(process);
        if (await cancelIfStale()) return;
        this.facadeProcess = process;
        await waitForTcp(webSocketEndpoint, timeoutMs);
      }

      if (await cancelIfStale()) return;
      this.state = "ready";
      this.log(`Local ASR ready: ${webSocketUrl} -> ${upstreamUrl}`);
    } catch (error) {
      if (lifecycleVersion !== this.lifecycleVersion) {
        await this.stopProcesses(ownedProcesses);
        if (lifecycleVersion === this.lifecycleVersion) {
          this.state = "stopped";
          this.lastError = undefined;
        }
        return;
      }
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`Local ASR startup failed: ${this.lastError}`);
      await this.stopOwnedProcesses();
      throw new Error(`Local Fun-ASR-Nano 启动失败：${this.lastError}`);
    }
  }

  private spawnOpenAsr(model: string): ChildProcess {
    const command = this.resolveOpenAsrCommand();
    const modelPack = this.options.resolveModelPack?.(model);
    const args = ["serve"];
    if (modelPack) args.push("--model-pack", modelPack);
    const openAsrHome = this.options.resolveOpenAsrHome?.();
    const env = openAsrHome ? { ...process.env, OPENASR_HOME: openAsrHome } : undefined;
    return this.spawnManaged(command, args, process.cwd(), "OpenASR", env);
  }

  private resolveOpenAsrCommand(): string {
    return this.options.openAsrPath || process.env.INTERVIEW_COPILOT_OPENASR_PATH || this.options.resolveOpenAsrPath?.() || "openasr";
  }

  private spawnFacade(input: { serviceRoot?: string; host: string; port: number; model: string; upstreamUrl: string }): ChildProcess {
    if (!input.serviceRoot) {
      throw new Error("找不到 local-asr-service/server.py。请重新安装软件或检查项目目录");
    }
    const scriptPath = join(input.serviceRoot, "server.py");
    if (!existsSync(scriptPath)) throw new Error(`找不到本地 ASR 服务脚本：${scriptPath}`);
    const python = this.resolvePython(input.serviceRoot);
    const args = [...python.args, scriptPath, "--host", input.host, "--port", String(input.port), "--model", input.model, "--upstream", input.upstreamUrl];
    return this.spawnManaged(python.command, args, input.serviceRoot, "Local ASR WebSocket facade");
  }

  private resolvePython(serviceRoot: string): { command: string; args: string[] } {
    const configured = this.options.pythonPath || process.env.INTERVIEW_COPILOT_PYTHON_PATH;
    if (configured) return { command: configured, args: [] };
    const localPython = firstExistingPath([
      join(serviceRoot, ".venv", "Scripts", "python.exe"),
      join(serviceRoot, ".venv", "bin", "python")
    ]);
    if (localPython) return { command: localPython, args: [] };
    return { command: process.platform === "win32" ? "python.exe" : "python3", args: [] };
  }

  private spawnManaged(command: string, args: string[], cwd: string, label: string, env?: NodeJS.ProcessEnv): ChildProcess {
    const spawnOptions: SpawnOptions = {
      cwd,
      windowsHide: true,
      ...(env ? { env } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    };
    const child = spawn(command, args, spawnOptions);
    child.stdout?.on("data", (data: Buffer) => this.log(`${label}: ${data.toString().trim()}`));
    child.stderr?.on("data", (data: Buffer) => this.log(`${label}: ${data.toString().trim()}`));
    child.once("error", (error) => this.log(`${label} process error: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.log(`${label} exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`);
      if (this.backendProcess === child) this.backendProcess = undefined;
      if (this.facadeProcess === child) this.facadeProcess = undefined;
      if (this.state === "ready") this.state = "error";
    });
    this.log(`Starting ${label}: ${command} ${args.join(" ")}`);
    return child;
  }

  private async stopOwnedProcesses(): Promise<void> {
    const processes = [this.facadeProcess, this.backendProcess].filter((process): process is ChildProcess => Boolean(process));
    await this.stopProcesses(processes);
  }

  private async stopProcesses(processes: ChildProcess[]): Promise<void> {
    await Promise.all(processes.map((process) => this.terminate(process)));
    if (this.facadeProcess && processes.includes(this.facadeProcess)) this.facadeProcess = undefined;
    if (this.backendProcess && processes.includes(this.backendProcess)) this.backendProcess = undefined;
  }

  private async terminate(process: ChildProcess): Promise<void> {
    const result = await terminateGracefully(process, {
      gracefulTimeoutMs: 1_000,
      forceTimeoutMs: 1_000,
      onEvent: (event, fields) => this.log(`${event}: pid=${fields.pid ?? "unknown"}`)
    });
    if (!result.exited) this.log(`Local ASR process exit timeout: pid=${process.pid ?? "unknown"}`);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
