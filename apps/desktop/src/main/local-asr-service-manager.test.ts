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
});
