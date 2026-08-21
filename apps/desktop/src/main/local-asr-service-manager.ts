import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";

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

export class LocalAsrServiceManager {
  private backendProcess: ChildProcess | undefined;
  private facadeProcess: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private state: LocalAsrServiceState = "stopped";
  private lastError: string | undefined;

  constructor(private readonly options: LocalAsrServiceOptions) {}

  getStatus(): { state: LocalAsrServiceState; error?: string } {
    return { state: this.state, error: this.lastError };
  }

  async ensureRunning(startOptions: LocalAsrStartOptions = {}): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(startOptions).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.startPromise = undefined;
    const processes = [this.facadeProcess, this.backendProcess].filter((process): process is ChildProcess => Boolean(process));
    this.facadeProcess = undefined;
    this.backendProcess = undefined;
    await Promise.all(processes.map((process) => this.terminate(process)));
    this.state = "stopped";
    this.lastError = undefined;
  }

  private async start(startOptions: LocalAsrStartOptions): Promise<void> {
    this.state = "starting";
    this.lastError = undefined;
    const timeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const webSocketUrl = startOptions.webSocketUrl || DEFAULT_WEBSOCKET_URL;
    const upstreamUrl = startOptions.upstreamUrl || this.options.upstreamUrl || DEFAULT_UPSTREAM_URL;
    const webSocketEndpoint = endpointFromUrl(webSocketUrl, 8765);
    const upstreamEndpoint = endpointFromUrl(upstreamUrl, 8080);
    const model = startOptions.model || DEFAULT_MODEL;

    try {
      const backendReady = await isTcpReachable(upstreamEndpoint);
      if (!backendReady) {
        this.backendProcess = this.spawnOpenAsr(model);
        await waitForTcp(upstreamEndpoint, timeoutMs);
      }

      const facadeReady = await isTcpReachable(webSocketEndpoint);
      if (!facadeReady) {
        this.facadeProcess = this.spawnFacade({
          serviceRoot: this.options.resolveServiceRoot(),
          host: webSocketEndpoint.host,
          port: webSocketEndpoint.port,
          model,
          upstreamUrl
        });
        await waitForTcp(webSocketEndpoint, timeoutMs);
      }

      this.state = "ready";
      this.log(`Local ASR ready: ${webSocketUrl} -> ${upstreamUrl}`);
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`Local ASR startup failed: ${this.lastError}`);
      await this.stopOwnedProcesses();
      throw new Error(`Local Fun-ASR-Nano 启动失败：${this.lastError}`);
    }
  }

  private spawnOpenAsr(model: string): ChildProcess {
    const command = this.options.openAsrPath || process.env.INTERVIEW_COPILOT_OPENASR_PATH || this.options.resolveOpenAsrPath?.() || "openasr";
    const modelPack = this.options.resolveModelPack?.(model);
    const args = ["serve"];
    if (modelPack) args.push("--model-pack", modelPack);
    const openAsrHome = this.options.resolveOpenAsrHome?.();
    const env = openAsrHome ? { ...process.env, OPENASR_HOME: openAsrHome } : undefined;
    return this.spawnManaged(command, args, process.cwd(), "OpenASR", env);
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
    this.facadeProcess = undefined;
    this.backendProcess = undefined;
    await Promise.all(processes.map((process) => this.terminate(process)));
  }

  private terminate(process: ChildProcess): Promise<void> {
    if (process.exitCode !== null || process.killed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        process.kill();
        resolve();
      }, 1_000);
      process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      process.kill();
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
