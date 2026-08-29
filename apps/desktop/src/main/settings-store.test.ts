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

  it("preserves the selected Qwen ASR model and derives its protocol endpoint", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      config.update("asr", { providerName: "Qwen Realtime ASR", providerType: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-audio-3.0-asr-flash-streaming", apiKey: "secret" });
      expect(config.get("asr")).toMatchObject({ providerType: "qwen", baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", model: "qwen-audio-3.0-asr-flash-streaming" });
      expect(config.getPublic().asr).toMatchObject({ baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", model: "qwen-audio-3.0-asr-flash-streaming", hasApiKey: true });
      config.update("asr", { model: "qwen3-asr-flash-realtime-2026-02-10" });
      expect(config.get("asr")).toMatchObject({ baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen3-asr-flash-realtime-2026-02-10" });
    } finally {
      database.close();
    }
  });

  it("preserves an existing API key when only the model changes", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const secrets = new MemorySecretStore();
      const config = new ProviderConfigStore(database, secrets);
      config.update("llm", { providerName: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: "first-key" });
      config.update("llm", { model: "deepseek-v4-pro", apiKey: undefined });
      expect(config.get("llm")).toMatchObject({ model: "deepseek-v4-pro", apiKey: "first-key" });
      expect(config.getPublic().llm.hasApiKey).toBe(true);
    } finally {
      database.close();
    }
  });

  it("updates and explicitly deletes an API key", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      config.update("llm", { apiKey: "first-key" });
      config.update("llm", { apiKey: "second-key" });
      expect(config.get("llm").apiKey).toBe("second-key");
      config.update("llm", { apiKey: "" });
      expect(config.get("llm").apiKey).toBe("");
      expect(config.getPublic().llm.hasApiKey).toBe(false);
    } finally {
      database.close();
    }
  });

  it("saves independent LLM profiles and switches the active model with its API key", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      const first = config.saveLlmProfile({ name: "小米 Mimo", providerName: "Xiaomi", baseUrl: "https://mimo.test/v1", model: "mimo-pro", fastModel: "mimo-fast", questionRecognitionModel: "mimo-classifier", profileBuilderModel: "mimo-profile", questionBankModel: "mimo-bank", chatModel: "mimo-chat", postInterviewModel: "mimo-review", preparationModel: "mimo-prep", timeoutMs: 30_000, maxRetries: 2, apiKey: "mimo-key" });
      const mimoProfile = first.llmProfiles.find((profile) => profile.name === "小米 Mimo");
      expect(mimoProfile).toBeDefined();
      expect(first.activeLlmProfileId).not.toBe(mimoProfile?.id);
      expect(mimoProfile).toMatchObject({ name: "小米 Mimo", model: "mimo-pro", fastModel: "mimo-fast", questionRecognitionModel: "mimo-classifier", profileBuilderModel: "mimo-profile", questionBankModel: "mimo-bank", chatModel: "mimo-chat", postInterviewModel: "mimo-review", preparationModel: "mimo-prep", hasApiKey: true });

      config.activateLlmProfile(mimoProfile?.id ?? "");

      const second = config.saveLlmProfile({ name: "DeepSeek", providerName: "DeepSeek", baseUrl: "https://deepseek.test/v1", model: "deepseek-chat", timeoutMs: 30_000, maxRetries: 2, apiKey: "deepseek-key" });
      expect(second.llmProfiles).toHaveLength(3);
      expect(second.activeLlmProfileId).toBe(mimoProfile?.id);
      expect(config.get("llm")).toMatchObject({ model: "mimo-pro", apiKey: "mimo-key" });

      const switched = config.activateLlmProfile(mimoProfile?.id ?? "");
      expect(switched.activeLlmProfileId).toBe(mimoProfile?.id);
      expect(config.get("llm")).toMatchObject({ model: "mimo-pro", apiKey: "mimo-key" });
      expect(JSON.stringify(switched)).not.toContain("mimo-key");
      expect(JSON.stringify(switched)).not.toContain("deepseek-key");
      expect(config.getLlmProfile(mimoProfile?.id ?? "")).toMatchObject({ model: "mimo-pro", apiKey: "mimo-key" });
    } finally {
      database.close();
    }
  });

  it("rejects an embedding model in an LLM task route", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      expect(() => config.saveLlmProfile({ name: "错误配置", providerName: "test", baseUrl: "https://llm.test/v1", model: "chat-model", projectAnalyzerModel: "text-embedding-v4", timeoutMs: 30_000, maxRetries: 2 })).toThrow("LLM_MODEL_CONFIGURATION_INVALID");
    } finally {
      database.close();
    }
  });

  it("does not allow deleting the last LLM profile", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const config = new ProviderConfigStore(database, new MemorySecretStore());
      const current = config.getPublic();
      expect(() => config.deleteLlmProfile(current.activeLlmProfileId)).toThrow("LLM_PROFILE_REQUIRED");
    } finally {
      database.close();
    }
  });
});

describe("OverlaySettingsStore", () => {
  it("persists and validates overlay appearance and module preferences", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const saved = settings.setPreferences({ backgroundOpacity: 0.42, backgroundColor: "#102030", fontColor: "#fefefe", fontSize: 19, showTranscript: false, showTimestamps: false });
      expect(saved).toMatchObject({ backgroundOpacity: 0.42, backgroundColor: "#102030", fontColor: "#fefefe", fontSize: 19, showTranscript: false, showTimestamps: false, showAnswer: true });
      expect(new OverlaySettingsStore(database).getPreferences()).toEqual(saved);
      expect(settings.setPreferences({ backgroundOpacity: 3, fontSize: 2, fontColor: "invalid" })).toMatchObject({ backgroundOpacity: 1, fontSize: 12, fontColor: "#f8fbff" });
    } finally { database.close(); }
  });

  it("persists independent window, behavior, preset, and screenshot settings", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const saved = settings.setPreferences({
        layoutPreset: "wide",
        questionWindow: { width: 460, height: 520, fontSize: 15, titleFontSize: 12, lineHeight: 1.7, paragraphGap: 9, padding: 14, opacity: 0.82, blur: 8, radius: 12, shadow: true },
        answerWindow: { width: 760, height: 520, fontSize: 16, titleFontSize: 12, lineHeight: 1.72, paragraphGap: 10, padding: 16, opacity: 0.86, blur: 10, radius: 12, shadow: true },
        behavior: { followLatestQuestion: false, followLatestAnswer: true, alwaysOnTop: true, lockPosition: true, mousePassthrough: true, autoDim: false, rememberPosition: true, rememberSize: true, showQuestionStatus: true, showAnswerStatus: true, compactHeader: true },
        screenshot: { middleMouseEnabled: true, enabledInManualInterview: true, enabledInExamMode: true, captureMode: "last_region", fixedRegion: { x: 10, y: 20, width: 800, height: 600 } }
      });
      expect(saved.layoutPreset).toBe("wide");
      expect(saved.questionWindow.width).toBe(460);
      expect(saved.answerWindow.fontSize).toBe(16);
      expect(saved.behavior.lockPosition).toBe(true);
      expect(saved.screenshot.captureMode).toBe("last_region");
      expect(new OverlaySettingsStore(database).getPreferences()).toEqual(saved);
    } finally { database.close(); }
  });

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
