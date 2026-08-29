import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { qwenAsrWebSocketUrl, QWEN_REALTIME_ASR_MODEL, validateLlmModelConfiguration, type AsrLanguage, type AsrProviderType, type ProviderSettings } from "@interview-copilot/shared";
import { APP_DATA_DIRECTORY, type SqliteDatabase } from "./database";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences, type OverlayPreferencesPatch, type OverlayRegion, type OverlayScreenshotPreferences, type OverlayWindowPreferences, type OverlayBehaviorPreferences } from "../shared/overlay-preferences";

export type { OverlayPreferences, OverlayPreferencesPatch } from "../shared/overlay-preferences";

export type ProviderSection = "llm" | "asr" | "embedding" | "reranker";

export interface PublicProviderSettings extends Omit<ProviderSettings, "apiKey"> {
  hasApiKey: boolean;
}

export interface PublicLlmModelProfile extends Omit<ProviderSettings, "apiKey"> {
  id: string;
  name: string;
  hasApiKey: boolean;
}

export interface LlmModelProfileInput extends Omit<ProviderSettings, "apiKey"> {
  id?: string;
  name: string;
  apiKey?: string;
}

export interface ProviderCenterPublicConfig {
  llm: PublicProviderSettings;
  llmProfiles: PublicLlmModelProfile[];
  activeLlmProfileId: string;
  asr: PublicProviderSettings;
  embedding: PublicProviderSettings;
  reranker?: PublicProviderSettings;
}

export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | undefined { return this.values.get(key); }
  set(key: string, value: string): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

export class SafeStorageSecretStore implements SecretStore {
  private readonly values: Record<string, string>;

  constructor(private readonly filePath: string, private readonly secureStorage: SafeStorageLike) {
    this.values = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string> : {};
  }

  get(key: string): string | undefined {
    const encoded = this.values[key];
    if (!encoded || !this.secureStorage.isEncryptionAvailable()) return undefined;
    try { return this.secureStorage.decryptString(Buffer.from(encoded, "base64")); } catch { return undefined; }
  }

  set(key: string, value: string): void {
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable");
    this.values[key] = this.secureStorage.encryptString(value).toString("base64");
    writeFileSync(this.filePath, JSON.stringify(this.values), { encoding: "utf8", mode: 0o600 });
  }

  delete(key: string): void {
    delete this.values[key];
    writeFileSync(this.filePath, JSON.stringify(this.values), { encoding: "utf8", mode: 0o600 });
  }
}

const DEFAULTS: Record<ProviderSection, ProviderSettings> = {
  llm: { providerName: "OpenAI-compatible", baseUrl: "https://api.openai.com", apiKey: "", model: "gpt-4o-mini", timeoutMs: 30_000, maxRetries: 2 },
  asr: { providerName: "Deepgram", providerType: "deepgram", baseUrl: "wss://api.deepgram.com/v1/listen", apiKey: "", model: "nova-3", language: "zh-CN", timeoutMs: 15_000, maxRetries: 2 },
  embedding: { providerName: "OpenAI-compatible", baseUrl: "https://api.openai.com", apiKey: "", model: "text-embedding-3-small", timeoutMs: 15_000, maxRetries: 2 },
  reranker: { providerName: "Disabled", baseUrl: "", apiKey: "", model: "", timeoutMs: 10_000, maxRetries: 1 }
};

function normalizeQwenAsrSettings(settings: ProviderSettings): ProviderSettings {
  if (settings.providerType !== "qwen") return settings;
  const model = settings.model.trim() || QWEN_REALTIME_ASR_MODEL;
  // Model choice is user data. Never rewrite it during load/save. The
  // transport URL is derived from the selected model family instead.
  return { ...settings, baseUrl: qwenAsrWebSocketUrl(model), model };
}

export class ProviderConfigStore {
  constructor(private readonly database: SqliteDatabase, private readonly secrets: SecretStore, private readonly defaults: Partial<Record<ProviderSection, Partial<ProviderSettings>>> = {}) {}

  private static readonly llmProfilesKey = "provider.llm.profiles";
  private static readonly activeLlmProfileKey = "provider.llm.activeProfileId";

  private getStoredProvider(section: ProviderSection): ProviderSettings {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [`provider.${section}`]);
    const configured = stored ? JSON.parse(stored.value) as Partial<ProviderSettings> : {};
    return { ...DEFAULTS[section], ...this.defaults[section], ...configured, apiKey: this.secrets.get(`provider.${section}.apiKey`) ?? "" };
  }

  private writeStoredProvider(section: ProviderSection, settings: ProviderSettings): void {
    const { apiKey: _apiKey, ...safe } = settings;
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`provider.${section}`, JSON.stringify(safe)]);
    this.database.flushNow();
  }

  private readLlmProfiles(): Array<Omit<ProviderSettings, "apiKey"> & { id: string; name: string }> {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [ProviderConfigStore.llmProfilesKey]);
    if (!stored) return [];
    try {
      const value = JSON.parse(stored.value) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter((profile): profile is Omit<ProviderSettings, "apiKey"> & { id: string; name: string } => Boolean(profile && typeof profile === "object" && typeof (profile as { id?: unknown }).id === "string" && typeof (profile as { name?: unknown }).name === "string"));
    } catch {
      return [];
    }
  }

  private writeLlmProfiles(profiles: Array<Omit<ProviderSettings, "apiKey"> & { id: string; name: string }>): void {
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [ProviderConfigStore.llmProfilesKey, JSON.stringify(profiles)]);
    this.database.flushNow();
  }

  private readActiveLlmProfileId(): string | undefined {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [ProviderConfigStore.activeLlmProfileKey]);
    if (!stored) return undefined;
    try {
      const value = JSON.parse(stored.value);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private writeActiveLlmProfileId(id: string): void {
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [ProviderConfigStore.activeLlmProfileKey, JSON.stringify(id)]);
    this.database.flushNow();
  }

  private profileSecretKey(id: string): string { return `provider.llm.profile.${id}.apiKey`; }

  private profileSettings(profile: Omit<ProviderSettings, "apiKey"> & { id: string; name: string }): ProviderSettings {
    return { ...profile, apiKey: this.secrets.get(this.profileSecretKey(profile.id)) ?? "" };
  }

  getLlmProfile(id: string): ProviderSettings {
    const { profiles } = this.ensureLlmProfiles();
    const profile = profiles.find((item) => item.id === id);
    if (!profile) throw new Error("LLM_PROFILE_NOT_FOUND: 模型配置不存在");
    return this.profileSettings(profile);
  }

  private publicLlmProfile(profile: Omit<ProviderSettings, "apiKey"> & { id: string; name: string }): PublicLlmModelProfile {
    const { apiKey: _apiKey, ...safe } = this.profileSettings(profile);
    return { id: profile.id, name: profile.name, ...safe, hasApiKey: Boolean(this.secrets.get(this.profileSecretKey(profile.id)) ?? "") };
  }

  private ensureLlmProfiles(): { profiles: Array<Omit<ProviderSettings, "apiKey"> & { id: string; name: string }>; activeId: string } {
    let profiles = this.readLlmProfiles();
    if (profiles.length === 0) {
      const current = this.getStoredProvider("llm");
      const { apiKey: _apiKey, ...safe } = current;
      const id = "llm-profile-default";
      profiles = [{ id, name: "默认模型配置", ...safe }];
      this.writeLlmProfiles(profiles);
      if (current.apiKey) this.secrets.set(this.profileSecretKey(id), current.apiKey);
      this.writeActiveLlmProfileId(id);
    }
    const storedActiveId = this.readActiveLlmProfileId();
    const activeId = profiles.some((profile) => profile.id === storedActiveId) ? storedActiveId as string : profiles[0].id;
    if (activeId !== storedActiveId) this.writeActiveLlmProfileId(activeId);
    return { profiles, activeId };
  }

  get(section: ProviderSection): ProviderSettings {
    if (section === "llm") {
      const profiles = this.readLlmProfiles();
      const activeId = this.readActiveLlmProfileId();
      const activeProfile = profiles.find((profile) => profile.id === activeId) ?? profiles[0];
      if (activeProfile) return this.profileSettings(activeProfile);
    }
    const merged = this.getStoredProvider(section);
    if (section !== "asr") return merged;
    const providerName = merged.providerName.toLowerCase();
    const providerType = (merged.providerType ?? (providerName.includes("custom") ? "custom-gateway" : providerName.includes("fun-asr") || providerName.includes("funasr") || providerName.includes("本地") ? "funasr-local" : providerName.includes("qwen") || providerName.includes("千问") ? "qwen" : "deepgram")) as AsrProviderType;
    const language = merged.language ? merged.language as AsrLanguage : undefined;
    return normalizeQwenAsrSettings({ ...merged, providerType, language });
  }

  getPublic(): ProviderCenterPublicConfig {
    const { profiles, activeId } = this.ensureLlmProfiles();
    const publicSettings = (section: ProviderSection): PublicProviderSettings => {
      const value = this.get(section);
      const { apiKey: _apiKey, ...safe } = value;
      return { ...safe, hasApiKey: Boolean(value.apiKey) };
    };
    return { llm: publicSettings("llm"), llmProfiles: profiles.map((profile) => this.publicLlmProfile(profile)), activeLlmProfileId: activeId, asr: publicSettings("asr"), embedding: publicSettings("embedding"), reranker: publicSettings("reranker") };
  }

  update(section: ProviderSection, input: Partial<ProviderSettings>): PublicProviderSettings {
    const current = this.get(section);
    const next = section === "asr" ? normalizeQwenAsrSettings({ ...current, ...input }) : { ...current, ...input };
    if (section === "llm") {
      const issues = validateLlmModelConfiguration(next);
      if (issues.length) throw new Error(`LLM_MODEL_CONFIGURATION_INVALID: ${issues.map((issue) => issue.message).join("；")}`);
      const { profiles, activeId } = this.ensureLlmProfiles();
      const activeProfile = profiles.find((profile) => profile.id === activeId) ?? profiles[0];
      const { apiKey: _apiKey, ...safe } = next;
      this.writeLlmProfiles(profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, ...safe } : profile));
      if (input.apiKey !== undefined) {
        if (input.apiKey) this.secrets.set(this.profileSecretKey(activeProfile.id), input.apiKey);
        else this.secrets.delete(this.profileSecretKey(activeProfile.id));
      }
      this.writeStoredProvider(section, next);
      return { ...safe, hasApiKey: Boolean(next.apiKey) };
    }
    if (input.apiKey !== undefined) {
      if (input.apiKey) this.secrets.set(`provider.${section}.apiKey`, input.apiKey);
      else this.secrets.delete(`provider.${section}.apiKey`);
    }
    const { apiKey: _apiKey, ...safe } = next;
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`provider.${section}`, JSON.stringify(safe)]);
    this.database.flushNow();
    return { ...safe, hasApiKey: Boolean(next.apiKey) };
  }

  saveLlmProfile(input: LlmModelProfileInput): ProviderCenterPublicConfig {
    const { profiles } = this.ensureLlmProfiles();
    const id = input.id?.trim() || `llm-profile-${randomUUID()}`;
    const existing = profiles.find((profile) => profile.id === id);
    const seed = existing ? this.profileSettings(existing) : { ...DEFAULTS.llm, ...this.defaults.llm, apiKey: "" };
    const { id: _id, name: rawName, apiKey, ...settings } = input;
    const nextSettings = { ...seed, ...settings };
    const issues = validateLlmModelConfiguration(nextSettings);
    if (issues.length) throw new Error(`LLM_MODEL_CONFIGURATION_INVALID: ${issues.map((issue) => issue.message).join("；")}`);
    const { apiKey: _apiKey, ...safe } = nextSettings;
    const nextProfile = { id, name: rawName.trim() || "未命名模型配置", ...safe };
    this.writeLlmProfiles(existing ? profiles.map((profile) => profile.id === id ? nextProfile : profile) : [...profiles, nextProfile]);
    if (apiKey !== undefined) {
      if (apiKey) this.secrets.set(this.profileSecretKey(id), apiKey);
      else this.secrets.delete(this.profileSecretKey(id));
    }
    const { activeId } = this.ensureLlmProfiles();
    if (id === activeId) this.writeStoredProvider("llm", { ...nextSettings, apiKey: apiKey ?? (existing ? this.secrets.get(this.profileSecretKey(id)) ?? "" : "") });
    return this.getPublic();
  }

  activateLlmProfile(id: string): ProviderCenterPublicConfig {
    const { profiles } = this.ensureLlmProfiles();
    const profile = profiles.find((item) => item.id === id);
    if (!profile) throw new Error("LLM_PROFILE_NOT_FOUND: 模型配置不存在");
    const settings = this.profileSettings(profile);
    this.writeActiveLlmProfileId(id);
    this.writeStoredProvider("llm", settings);
    if (settings.apiKey) this.secrets.set("provider.llm.apiKey", settings.apiKey);
    else this.secrets.delete("provider.llm.apiKey");
    return this.getPublic();
  }

  deleteLlmProfile(id: string): ProviderCenterPublicConfig {
    const { profiles, activeId } = this.ensureLlmProfiles();
    if (profiles.length <= 1) throw new Error("LLM_PROFILE_REQUIRED: 至少保留一个模型配置");
    const nextProfiles = profiles.filter((profile) => profile.id !== id);
    if (nextProfiles.length === profiles.length) throw new Error("LLM_PROFILE_NOT_FOUND: 模型配置不存在");
    this.writeLlmProfiles(nextProfiles);
    this.secrets.delete(this.profileSecretKey(id));
    const nextActiveId = activeId === id ? nextProfiles[0].id : activeId;
    this.writeActiveLlmProfileId(nextActiveId);
    return this.activateLlmProfile(nextActiveId);
  }
}

export interface OverlayCaptureProtectionSettings {
  captureProtection: boolean;
}

function normalizeOverlayPreferences(input: OverlayPreferencesPatch): OverlayPreferences {
  const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  const number = (value: unknown, fallback: number, minimum: number, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
  const flag = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  const coordinate = (value: unknown, fallback?: number) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  const region = (value: unknown, fallback?: OverlayRegion): OverlayRegion | undefined => {
    if (!value || typeof value !== "object") return fallback;
    const candidate = value as Partial<OverlayRegion>;
    const width = number(candidate.width, fallback?.width ?? 0, 1, 20_000);
    const height = number(candidate.height, fallback?.height ?? 0, 1, 20_000);
    if (!width || !height) return fallback;
    return { x: coordinate(candidate.x, fallback?.x ?? 0) ?? 0, y: coordinate(candidate.y, fallback?.y ?? 0) ?? 0, width, height };
  };
  const windowPreferences = (value: Partial<OverlayWindowPreferences> | undefined, fallback: OverlayWindowPreferences): OverlayWindowPreferences => ({
    width: number(value?.width, fallback.width, 260, 2_400),
    height: number(value?.height, fallback.height, 160, 1_600),
    ...(coordinate(value?.x, fallback.x) !== undefined ? { x: coordinate(value?.x, fallback.x) } : {}),
    ...(coordinate(value?.y, fallback.y) !== undefined ? { y: coordinate(value?.y, fallback.y) } : {}),
    fontSize: number(value?.fontSize, fallback.fontSize, 11, 32),
    titleFontSize: number(value?.titleFontSize, fallback.titleFontSize, 10, 24),
    lineHeight: number(value?.lineHeight, fallback.lineHeight, 1.2, 2.4),
    paragraphGap: number(value?.paragraphGap, fallback.paragraphGap, 0, 36),
    padding: number(value?.padding, fallback.padding, 6, 40),
    opacity: number(value?.opacity, fallback.opacity, 0.2, 1),
    blur: number(value?.blur, fallback.blur, 0, 40),
    radius: number(value?.radius, fallback.radius, 0, 32),
    shadow: flag(value?.shadow, fallback.shadow)
  });
  const behavior = (value: Partial<OverlayBehaviorPreferences> | undefined): OverlayBehaviorPreferences => ({ ...DEFAULT_OVERLAY_PREFERENCES.behavior, ...(value ?? {}), followLatestQuestion: flag(value?.followLatestQuestion, DEFAULT_OVERLAY_PREFERENCES.behavior.followLatestQuestion), followLatestAnswer: flag(value?.followLatestAnswer, DEFAULT_OVERLAY_PREFERENCES.behavior.followLatestAnswer), alwaysOnTop: flag(value?.alwaysOnTop, DEFAULT_OVERLAY_PREFERENCES.behavior.alwaysOnTop), lockPosition: flag(value?.lockPosition, DEFAULT_OVERLAY_PREFERENCES.behavior.lockPosition), mousePassthrough: flag(value?.mousePassthrough, DEFAULT_OVERLAY_PREFERENCES.behavior.mousePassthrough), autoDim: flag(value?.autoDim, DEFAULT_OVERLAY_PREFERENCES.behavior.autoDim), rememberPosition: flag(value?.rememberPosition, DEFAULT_OVERLAY_PREFERENCES.behavior.rememberPosition), rememberSize: flag(value?.rememberSize, DEFAULT_OVERLAY_PREFERENCES.behavior.rememberSize), showQuestionStatus: flag(value?.showQuestionStatus, DEFAULT_OVERLAY_PREFERENCES.behavior.showQuestionStatus), showAnswerStatus: flag(value?.showAnswerStatus, DEFAULT_OVERLAY_PREFERENCES.behavior.showAnswerStatus), compactHeader: flag(value?.compactHeader, DEFAULT_OVERLAY_PREFERENCES.behavior.compactHeader) });
  const screenshot = (value: Partial<OverlayScreenshotPreferences> | undefined): OverlayScreenshotPreferences => {
    const captureMode = value?.captureMode === "full_screen" || value?.captureMode === "current_display" || value?.captureMode === "fixed_region" || value?.captureMode === "last_region" || value?.captureMode === "interactive" ? value.captureMode : DEFAULT_OVERLAY_PREFERENCES.screenshot.captureMode;
    return { middleMouseEnabled: flag(value?.middleMouseEnabled, DEFAULT_OVERLAY_PREFERENCES.screenshot.middleMouseEnabled), enabledInManualInterview: flag(value?.enabledInManualInterview, DEFAULT_OVERLAY_PREFERENCES.screenshot.enabledInManualInterview), enabledInExamMode: flag(value?.enabledInExamMode, DEFAULT_OVERLAY_PREFERENCES.screenshot.enabledInExamMode), captureMode, ...(region(value?.fixedRegion, DEFAULT_OVERLAY_PREFERENCES.screenshot.fixedRegion) ? { fixedRegion: region(value?.fixedRegion, DEFAULT_OVERLAY_PREFERENCES.screenshot.fixedRegion) } : {}), ...(region(value?.lastRegion, DEFAULT_OVERLAY_PREFERENCES.screenshot.lastRegion) ? { lastRegion: region(value?.lastRegion, DEFAULT_OVERLAY_PREFERENCES.screenshot.lastRegion) } : {}) };
  };
  return {
    backgroundOpacity: number(input.backgroundOpacity, DEFAULT_OVERLAY_PREFERENCES.backgroundOpacity, 0.2, 1),
    backgroundColor: color(input.backgroundColor, DEFAULT_OVERLAY_PREFERENCES.backgroundColor),
    fontColor: color(input.fontColor, DEFAULT_OVERLAY_PREFERENCES.fontColor),
    fontSize: number(input.fontSize, DEFAULT_OVERLAY_PREFERENCES.fontSize, 12, 28),
    showToolbar: flag(input.showToolbar, DEFAULT_OVERLAY_PREFERENCES.showToolbar),
    showTranscript: flag(input.showTranscript, DEFAULT_OVERLAY_PREFERENCES.showTranscript),
    showAnswer: flag(input.showAnswer, DEFAULT_OVERLAY_PREFERENCES.showAnswer),
    showTimestamps: flag(input.showTimestamps, DEFAULT_OVERLAY_PREFERENCES.showTimestamps),
    layoutPreset: input.layoutPreset === "compact" || input.layoutPreset === "standard" || input.layoutPreset === "wide" || input.layoutPreset === "dual_screen" || input.layoutPreset === "custom" ? input.layoutPreset : DEFAULT_OVERLAY_PREFERENCES.layoutPreset,
    questionWindow: windowPreferences(input.questionWindow, DEFAULT_OVERLAY_PREFERENCES.questionWindow),
    answerWindow: windowPreferences(input.answerWindow, DEFAULT_OVERLAY_PREFERENCES.answerWindow),
    behavior: behavior(input.behavior),
    screenshot: screenshot(input.screenshot)
  };
}

export type TencentValidationStatus = "unverified" | "verified" | "failed";
export type AutomationMode = "AUTO" | "MANUAL";

export interface TencentValidationState {
  desktopShare: TencentValidationStatus;
  windowShare: TencentValidationStatus;
}

export class OverlaySettingsStore {
  private static readonly key = "overlay.captureProtection";
  private static readonly preferencesKey = "overlay.preferences";
  private static readonly tencentValidationKey = "overlay.tencentValidation";
  private static readonly automationModeKey = "interview.automationMode";

  constructor(private readonly database: SqliteDatabase) {}

  get(): OverlayCaptureProtectionSettings {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [OverlaySettingsStore.key]);
    if (!stored) return { captureProtection: true };
    try {
      return { captureProtection: JSON.parse(stored.value) === true };
    } catch {
      return { captureProtection: true };
    }
  }

  setCaptureProtection(enabled: boolean): OverlayCaptureProtectionSettings {
    const value = Boolean(enabled);
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [OverlaySettingsStore.key, JSON.stringify(value)]);
    this.database.flushNow();
    return { captureProtection: value };
  }

  getPreferences(): OverlayPreferences {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [OverlaySettingsStore.preferencesKey]);
    if (!stored) return { ...DEFAULT_OVERLAY_PREFERENCES };
    try { return normalizeOverlayPreferences(JSON.parse(stored.value) as Partial<OverlayPreferences>); }
    catch { return { ...DEFAULT_OVERLAY_PREFERENCES }; }
  }

  setPreferences(input: OverlayPreferencesPatch): OverlayPreferences {
    const current = this.getPreferences();
    const next = normalizeOverlayPreferences({ ...current, ...input, questionWindow: { ...current.questionWindow, ...(input.questionWindow ?? {}) }, answerWindow: { ...current.answerWindow, ...(input.answerWindow ?? {}) }, behavior: { ...current.behavior, ...(input.behavior ?? {}) }, screenshot: { ...current.screenshot, ...(input.screenshot ?? {}) } });
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [OverlaySettingsStore.preferencesKey, JSON.stringify(next)]);
    this.database.flushNow();
    return next;
  }

  getAutomationMode(): AutomationMode {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [OverlaySettingsStore.automationModeKey]);
    return stored?.value === '"MANUAL"' ? "MANUAL" : "AUTO";
  }

  setAutomationMode(mode: AutomationMode): AutomationMode {
    const value = mode === "MANUAL" ? "MANUAL" : "AUTO";
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [OverlaySettingsStore.automationModeKey, JSON.stringify(value)]);
    this.database.flushNow();
    return value;
  }

  getTencentValidation(): TencentValidationState {
    const fallback: TencentValidationState = { desktopShare: "unverified", windowShare: "unverified" };
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [OverlaySettingsStore.tencentValidationKey]);
    if (!stored) return fallback;
    try {
      const value = JSON.parse(stored.value) as Partial<TencentValidationState>;
      return {
        desktopShare: value.desktopShare === "verified" || value.desktopShare === "failed" ? value.desktopShare : "unverified",
        windowShare: value.windowShare === "verified" || value.windowShare === "failed" ? value.windowShare : "unverified"
      };
    } catch { return fallback; }
  }

  setTencentValidation(mode: "desktopShare" | "windowShare", status: TencentValidationStatus): TencentValidationState {
    const next = { ...this.getTencentValidation(), [mode]: status };
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [OverlaySettingsStore.tencentValidationKey, JSON.stringify(next)]);
    this.database.flushNow();
    return next;
  }
}

export async function createSecretStore(appDataPath: string): Promise<SafeStorageSecretStore> {
  const { safeStorage: secureStorage } = await import("electron");
  const directory = join(appDataPath, APP_DATA_DIRECTORY);
  await mkdir(directory, { recursive: true });
  return new SafeStorageSecretStore(join(directory, "secrets.json"), secureStorage);
}
