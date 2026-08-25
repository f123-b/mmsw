import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LocalAsrServiceManager } from "./local-asr-service-manager";

describe("LocalAsrServiceManager health check", () => {
  it("reports each local ASR dependency and port layer explicitly", async () => {
    const health = await new LocalAsrServiceManager({
      resolveServiceRoot: () => undefined,
      pythonPath: "C:/missing/mmsw-python.exe",
      openAsrPath: "C:/missing/openasr.exe"
    }).getHealthCheck();
    expect(health).toMatchObject({
      overall: "not_ready",
      serviceRoot: { ok: false },
      python: { ok: false },
      openasr: { ok: false },
      venv: { ok: false },
      dependencies: { ok: false },
      model: { ok: false },
      facadePort: { ok: false },
      backendPort: { ok: false },
      runtime: { backendRunning: false, facadeRunning: false }
    });
  });

  it("reports a present service root with a missing server.py accurately", async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), "mmsw-local-asr-"));
    try {
      const health = await new LocalAsrServiceManager({
        resolveServiceRoot: () => serviceRoot,
        pythonPath: "C:/missing/mmsw-python.exe",
        openAsrPath: "C:/missing/openasr.exe"
      }).getHealthCheck();
      expect(health.serviceRoot).toMatchObject({ ok: false, path: serviceRoot, reason: "server.py not found" });
      expect(health.dependencies.reason).toBe("server.py not found");
      expect(health.overall).toBe("not_ready");
    } finally {
      await rm(serviceRoot, { recursive: true, force: true });
    }
  });
});
