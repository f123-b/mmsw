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
      const saved = settings.setPreferences({ backgroundOpacity: 0.42, backgroundColor: "#102030", fontColor: "#fefefe", fontSize: 19, showTimestamps: false, interview: { leftPanel: "hidden", showAnswer: true } });
      expect(saved).toMatchObject({ schemaVersion: 4, backgroundOpacity: 0.42, backgroundColor: "#102030", fontColor: "#fefefe", fontSize: 19, showTimestamps: false, interview: { leftPanel: "hidden", showAnswer: true } });
      expect(new OverlaySettingsStore(database).getPreferences()).toEqual(saved);
      expect(settings.setPreferences({ backgroundOpacity: 3, fontSize: 2, fontColor: "invalid" })).toMatchObject({ backgroundOpacity: 1, fontSize: 12, fontColor: "#f8fbff" });
    } finally { database.close(); }
  });

  it("persists independent window, behavior, preset, and screenshot settings", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const saved = settings.setPreferences({
        interview: { layoutPreset: "answer_focus", questionWindow: { width: 460, height: 520, fontSize: 15, titleFontSize: 12, lineHeight: 1.7, paragraphGap: 9, padding: 14, opacity: 0.82, blur: 8, radius: 12, shadow: true }, answerWindow: { width: 760, height: 520, fontSize: 16, titleFontSize: 12, lineHeight: 1.72, paragraphGap: 10, padding: 16, opacity: 0.86, blur: 10, radius: 12, shadow: true } },
        writtenTest: { layoutPreset: "split", questionWindow: { width: 520, height: 520 }, answerWindow: { width: 760, height: 520 } },
        behavior: { followLatestQuestion: false, followLatestAnswer: true, alwaysOnTop: true, lockPosition: true, mousePassthrough: true, autoDim: false, rememberPosition: true, rememberSize: true, showQuestionStatus: true, showAnswerStatus: true, compactHeader: true },
        screenshot: { middleMouseEnabled: true, enabledInManualInterview: true, enabledInExamMode: true, captureMode: "last_region", fixedRegion: { x: 10, y: 20, width: 800, height: 600 } }
      });
      expect(saved.interview.layoutPreset).toBe("answer_focus");
      expect(saved.interview.questionWindow.width).toBe(460);
      expect(saved.interview.answerWindow.fontSize).toBe(16);
      expect(saved.writtenTest.layoutPreset).toBe("split");
      expect(saved.behavior.lockPosition).toBe(true);
      expect(saved.screenshot.captureMode).toBe("last_region");
      expect(new OverlaySettingsStore(database).getPreferences()).toEqual(saved);
    } finally { database.close(); }
  });

  it("migrates flat legacy overlay settings without creating a second store", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      database.run("INSERT INTO app_state(key, value) VALUES (?, ?)", ["overlay.preferences", JSON.stringify({ backgroundOpacity: 0, backgroundColor: "#102030", fontColor: "#ffffff", fontSize: 10, width: 900, height: 0 })]);
      const preferences = new OverlaySettingsStore(database).getPreferences();
      expect(preferences.schemaVersion).toBe(4);
      expect(preferences.interview.questionWindow).toMatchObject({ width: 900, height: 500, fontSize: 10, backgroundOpacity: 0, textColor: "#ffffff" });
      expect(preferences.interview.answerWindow).toMatchObject({ width: 900, height: 500, fontSize: 10, backgroundOpacity: 0, textColor: "#ffffff" });
      expect(preferences.writtenTest.questionWindow).toMatchObject({ width: 900, height: 560, fontSize: 10, backgroundOpacity: 0, textColor: "#ffffff" });
      expect(preferences.behavior.interactionMode).toBe("click_through");
      expect(preferences.appearance.mode).toBe("glass");
      expect(new OverlaySettingsStore(database).setPreferences({ behavior: { mousePassthrough: true } }).behavior.interactionMode).toBe("click_through");
    } finally { database.close(); }
  });

  it("migrates legacy interactive preferences once and preserves later user edits", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      database.run("INSERT INTO app_state(key, value) VALUES (?, ?)", ["overlay.preferences", JSON.stringify({ behavior: { interactionMode: "interactive", mousePassthrough: false, lockLayout: false }, questionWindow: { width: 500 } })]);
      const settings = new OverlaySettingsStore(database);
      const migrated = settings.getPreferences();
      expect(migrated.schemaVersion).toBe(4);
      expect(migrated.behavior).toMatchObject({ interactionMode: "click_through", mousePassthrough: true, lockLayout: true });
      const storedAfterMigration = database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", ["overlay.preferences"]);
      expect(JSON.parse(storedAfterMigration?.value ?? "{}").schemaVersion).toBe(4);

      const edited = settings.setPreferences({ behavior: { interactionMode: "interactive", lockLayout: false } });
      expect(edited.behavior).toMatchObject({ interactionMode: "interactive", mousePassthrough: false, lockLayout: false });
      expect(new OverlaySettingsStore(database).getPreferences().behavior).toMatchObject({ interactionMode: "interactive", mousePassthrough: false, lockLayout: false });
    } finally { database.close(); }
  });

  it("migrates legacy oversized runtime geometry to the compact defaults", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      database.run("INSERT INTO app_state(key, value) VALUES (?, ?)", ["overlay.preferences", JSON.stringify({ schemaVersion: 2, layoutPreset: "standard", controlBar: { width: 680, height: 50 } })]);
      const preferences = new OverlaySettingsStore(database).getPreferences();
      expect(preferences.schemaVersion).toBe(4);
      expect(preferences.interview.layoutPreset).toBe("classic_split");
      expect(preferences.interview.controlBar).toMatchObject({ width: 680, height: 50 });
    } finally { database.close(); }
  });

  it("normalizes an old dialogue-only v4 layout to canonical question geometry", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      database.run("INSERT INTO app_state(key, value) VALUES (?, ?)", ["overlay.preferences", JSON.stringify({ schemaVersion: 4, interview: { layoutPreset: "classic_split", leftPanel: "dialogue", dialogueWindow: { x: 120, y: 80, width: 440, height: 510, displayId: 7, scaleFactor: 1.25 } }, writtenTest: { layoutPreset: "single_reader" } })]);
      const preferences = new OverlaySettingsStore(database).getPreferences();
      expect(preferences.interview.questionWindow).toMatchObject({ x: 120, y: 80, width: 440, height: 510, displayId: 7, scaleFactor: 1.25 });
      expect(preferences.interview.dialogueWindow).toMatchObject({ x: 120, y: 80, width: 440, height: 510, displayId: 7, scaleFactor: 1.25 });
    } finally { database.close(); }
  });

  it("persists display selection independently for interview and written-test layouts", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const next = settings.setPreferences({
        interview: { questionWindow: { displayId: 1, scaleFactor: 1 }, answerWindow: { displayId: 1, scaleFactor: 1 }, controlBar: { displayId: 1, scaleFactor: 1 } },
        writtenTest: { questionWindow: { displayId: 2, scaleFactor: 1.25 }, answerWindow: { displayId: 2, scaleFactor: 1.25 }, controlBar: { displayId: 2, scaleFactor: 1.25 } }
      });
      expect(next.interview.questionWindow.displayId).toBe(1);
      expect(next.interview.answerWindow.displayId).toBe(1);
      expect(next.writtenTest.questionWindow.displayId).toBe(2);
      expect(next.writtenTest.answerWindow.scaleFactor).toBe(1.25);
    } finally { database.close(); }
  });

  it("normalizes every panel to the canonical mode display and shared preset constraints", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const next = settings.setPreferences({
        interview: {
          layoutPreset: "classic_split",
          questionWindow: { displayId: 1, scaleFactor: 1, height: 500 },
          answerWindow: { displayId: 2, scaleFactor: 1.25, height: 700 },
          controlBar: { displayId: 3, scaleFactor: 1.5, height: 72 }
        },
        writtenTest: {
          layoutPreset: "split",
          questionWindow: { displayId: 4, scaleFactor: 1.25, height: 600 },
          answerWindow: { displayId: 5, scaleFactor: 1.5, height: 700 },
          controlBar: { displayId: 6, scaleFactor: 1, height: 90 }
        }
      });
      expect(next.interview.questionWindow).toMatchObject({ displayId: 1, scaleFactor: 1, height: 500 });
      expect(next.interview.answerWindow).toMatchObject({ displayId: 1, scaleFactor: 1, height: 700 });
      expect(next.interview.controlBar).toMatchObject({ displayId: 1, scaleFactor: 1, height: 72 });
      expect(next.writtenTest.questionWindow).toMatchObject({ displayId: 4, scaleFactor: 1.25, height: 600 });
      expect(next.writtenTest.answerWindow).toMatchObject({ displayId: 4, scaleFactor: 1.25, height: 700 });
      expect(next.writtenTest.controlBar).toMatchObject({ displayId: 4, scaleFactor: 1.25, height: 90 });
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

  it("keeps custom control-bar placement across partial saves and clamps designer ranges", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const saved = settings.setPreferences({
        interview: { questionWindow: { width: 2_000, height: 1, fontSize: 40, backgroundOpacity: 0, textOpacity: 1, borderOpacity: 0 }, answerWindow: { width: 2_000, height: 1, fontSize: 40 }, controlBar: { x: 144, y: 280, positionMode: "custom", orientation: "vertical" } },
        appearance: { mode: "text_only", radius: 99 },
        behavior: { interactionMode: "full_passthrough", snapEnabled: false, snapThreshold: 99 }
      });
      expect(saved.interview.questionWindow).toMatchObject({ width: 900, height: 220, fontSize: 32, backgroundOpacity: 0, textOpacity: 1, borderOpacity: 0 });
      expect(saved.interview.answerWindow).toMatchObject({ width: 1_100, height: 220, fontSize: 40 });
      expect(saved.interview.controlBar).toMatchObject({ x: 144, y: 280, positionMode: "custom", orientation: "vertical" });
      expect(saved.appearance).toMatchObject({ mode: "text_only", radius: 32 });
      expect(saved.behavior).toMatchObject({ interactionMode: "full_passthrough", mousePassthrough: true, snapEnabled: false, snapThreshold: 16 });

      const partial = settings.setPreferences({ interview: { controlBar: { x: 210, y: 310, width: 720, height: 72 } } });
      expect(partial.interview.controlBar).toMatchObject({ x: 210, y: 310, width: 720, height: 72, positionMode: "custom", orientation: "vertical" });
    } finally {
      database.close();
    }
  });

  it("keeps the selected preset while manual geometry becomes the runtime source of truth", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      expect(settings.setPreferences({ interview: { layoutPreset: "classic_split" } }).interview.layoutPreset).toBe("classic_split");
      const edited = settings.setPreferences({ interview: { questionWindow: { x: 640, width: 444 } } });
      expect(edited.interview.layoutPreset).toBe("classic_split");
      expect(edited.interview.questionWindow).toMatchObject({ x: 640, width: 444 });
      expect(edited.interview.dialogueWindow).toMatchObject({ x: 640, width: 444 });
      expect(settings.setPreferences({ interview: { layoutPreset: "answer_focus", answerWindow: { x: 700, width: 940 } } }).interview.layoutPreset).toBe("answer_focus");
    } finally { database.close(); }
  });

  it("keeps dialogue text and background preferences independent from the question window", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const next = settings.setPreferences({ interview: { questionWindow: { fontSize: 18, backgroundColor: "#111111" }, dialogueWindow: { fontSize: 13, backgroundColor: "#eeeeee" } } });
      expect(next.interview.questionWindow).toMatchObject({ fontSize: 18, backgroundColor: "#111111" });
      expect(next.interview.dialogueWindow).toMatchObject({ fontSize: 13, backgroundColor: "#eeeeee" });
      const questionOnly = settings.setPreferences({ interview: { questionWindow: { fontSize: 19 } } });
      expect(questionOnly.interview.questionWindow.fontSize).toBe(19);
      expect(questionOnly.interview.dialogueWindow.fontSize).toBe(13);
    } finally { database.close(); }
  });

  it("resolves high-frequency previews without persisting until the final save", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      const saved = settings.setPreferences({ interview: { questionWindow: { fontSize: 14 } } });
      const persistedBefore = database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", ["overlay.preferences"])?.value;
      for (let index = 0; index < 100; index += 1) settings.previewPreferences({ interview: { questionWindow: { fontSize: 14 + index / 100 } } });
      expect(settings.getPreferences()).toEqual(saved);
      expect(database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", ["overlay.preferences"])?.value).toBe(persistedBefore);
      const final = settings.setPreferences({ interview: { questionWindow: { fontSize: 16 } } });
      expect(final.interview.questionWindow.fontSize).toBe(16);
      expect(database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", ["overlay.preferences"])?.value).not.toBe(persistedBefore);
    } finally { database.close(); }
  });

  it("resets only the persisted overlay layout through the settings store", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      settings.setPreferences({
        interview: { layoutPreset: "minimal", questionWindow: { x: 900, y: 500, width: 760, height: 800 }, answerWindow: { x: 20, y: 40, width: 1_200, height: 900 }, controlBar: { x: 20, y: 20, positionMode: "custom" } },
        writtenTest: { layoutPreset: "split", questionWindow: { x: 100 }, answerWindow: { x: 200 } }
      });
      const next = settings.resetLayout();
      expect(next.interview.layoutPreset).toBe("classic_split");
      expect(next.interview.questionWindow.x).toBeUndefined();
      expect(next.interview.answerWindow.x).toBeUndefined();
      expect(next.interview.controlBar.positionMode).toBe("top_center");
      expect(next.writtenTest.layoutPreset).toBe("single_reader");
      expect(next.behavior.lockLayout).toBe(true);
    } finally {
      database.close();
    }
  });

  it("keeps reset scopes explicit", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const settings = new OverlaySettingsStore(database);
      settings.setPreferences({ behavior: { interactionMode: "interactive", lockLayout: false }, appearance: { mode: "text_only" }, interview: { questionWindow: { x: 900 } } });
      const layoutReset = settings.resetLayout();
      expect(layoutReset.interview.questionWindow.x).toBeUndefined();
      expect(layoutReset.behavior.interactionMode).toBe("interactive");
      expect(layoutReset.appearance.mode).toBe("text_only");
      const interactionReset = settings.resetInteraction();
      expect(interactionReset.behavior.interactionMode).toBe("click_through");
      expect(interactionReset.appearance.mode).toBe("text_only");
      const appearanceReset = settings.resetAppearance();
      expect(appearanceReset.appearance.mode).toBe("glass");
    } finally { database.close(); }
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
