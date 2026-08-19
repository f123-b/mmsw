import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database";
import { MemorySecretStore, OverlaySettingsStore, ProviderConfigStore } from "./settings-store";

describe("ProviderConfigStore", () => {
  it("keeps API keys in SecretStore and never returns them in public config", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const secrets = new MemorySecretStore();
      const config = new ProviderConfigStore(database, secrets);
      config.update("llm", { baseUrl: "https://llm.test", model: "qwen-max", apiKey: "secret-key" });
      expect(config.get("llm").apiKey).toBe("secret-key");
      expect(config.getPublic().llm).toMatchObject({ baseUrl: "https://llm.test", model: "qwen-max", hasApiKey: true });
      expect(JSON.stringify(config.getPublic())).not.toContain("secret-key");
    } finally {
      database.close();
    }
  });

  it("defaults ASR to Deepgram Direct with one model and Chinese language", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      expect(config.get("asr")).toMatchObject({ providerType: "deepgram", providerName: "Deepgram", model: "nova-3", language: "zh-CN" });
      expect(config.getPublic().asr).not.toHaveProperty("apiKey");
    } finally {
      database.close();
    }
  });
});

describe("OverlaySettingsStore", () => {
  it("defaults to enabled and persists the main-process setting", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      expect(settings.get()).toEqual({ captureProtection: true });
      settings.setCaptureProtection(false);
      expect(settings.get()).toEqual({ captureProtection: false });
      settings.setCaptureProtection(true);
      expect(settings.get()).toEqual({ captureProtection: true });
    } finally {
      database.close();
    }
  });

  it("persists Tencent desktop and window validation independently", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      expect(settings.getTencentValidation()).toEqual({ desktopShare: "unverified", windowShare: "unverified" });
      settings.setTencentValidation("desktopShare", "verified");
      settings.setTencentValidation("windowShare", "failed");
      expect(settings.getTencentValidation()).toEqual({ desktopShare: "verified", windowShare: "failed" });
    } finally { database.close(); }
  });

  it("AUTOMATION_DEFAULT_AUTO", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      expect(settings.getAutomationMode()).toBe("AUTO");
      settings.setAutomationMode("MANUAL");
      expect(settings.getAutomationMode()).toBe("MANUAL");
      settings.setAutomationMode("AUTO");
      expect(settings.getAutomationMode()).toBe("AUTO");
    } finally { database.close(); }
  });

  it("AUTOMATION_PERSIST_MANUAL", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      settings.setAutomationMode("MANUAL");
      expect(settings.getAutomationMode()).toBe("MANUAL");
    } finally { database.close(); }
  });

  it("AUTOMATION_RESTART_RESTORES_MANUAL", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      new OverlaySettingsStore(database).setAutomationMode("MANUAL");
      expect(new OverlaySettingsStore(database).getAutomationMode()).toBe("MANUAL");
    } finally { database.close(); }
  });

  it("AUTOMATION_RESTART_RESTORES_AUTO", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      settings.setAutomationMode("MANUAL");
      settings.setAutomationMode("AUTO");
      expect(new OverlaySettingsStore(database).getAutomationMode()).toBe("AUTO");
    } finally { database.close(); }
  });
});
