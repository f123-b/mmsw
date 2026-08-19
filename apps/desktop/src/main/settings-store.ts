import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AsrLanguage, AsrProviderType, ProviderSettings } from "@interview-copilot/shared";
import { APP_DATA_DIRECTORY, type SqliteDatabase } from "./database";

export type ProviderSection = "llm" | "asr" | "embedding" | "reranker";

export interface PublicProviderSettings extends Omit<ProviderSettings, "apiKey"> {
  hasApiKey: boolean;
}

export interface ProviderCenterPublicConfig {
  llm: PublicProviderSettings;
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

export class ProviderConfigStore {
  constructor(private readonly database: SqliteDatabase, private readonly secrets: SecretStore, private readonly defaults: Partial<Record<ProviderSection, Partial<ProviderSettings>>> = {}) {}

  get(section: ProviderSection): ProviderSettings {
    const stored = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = ?", [`provider.${section}`]);
    const configured = stored ? JSON.parse(stored.value) as Partial<ProviderSettings> : {};
    const merged = { ...DEFAULTS[section], ...this.defaults[section], ...configured, apiKey: this.secrets.get(`provider.${section}.apiKey`) ?? "" };
    if (section !== "asr") return merged;
    const providerType = (merged.providerType ?? (merged.providerName.toLowerCase().includes("custom") ? "custom-gateway" : "deepgram")) as AsrProviderType;
    const language = merged.language ? merged.language as AsrLanguage : undefined;
    return { ...merged, providerType, language };
  }

  getPublic(): ProviderCenterPublicConfig {
    const publicSettings = (section: ProviderSection): PublicProviderSettings => {
      const value = this.get(section);
      const { apiKey: _apiKey, ...safe } = value;
      return { ...safe, hasApiKey: Boolean(value.apiKey) };
    };
    return { llm: publicSettings("llm"), asr: publicSettings("asr"), embedding: publicSettings("embedding"), reranker: publicSettings("reranker") };
  }

  update(section: ProviderSection, input: Partial<ProviderSettings>): PublicProviderSettings {
    const current = this.get(section);
    const next = { ...current, ...input };
    if (input.apiKey !== undefined) {
      if (input.apiKey) this.secrets.set(`provider.${section}.apiKey`, input.apiKey);
      else this.secrets.delete(`provider.${section}.apiKey`);
    }
    const { apiKey: _apiKey, ...safe } = next;
    this.database.run("INSERT INTO app_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`provider.${section}`, JSON.stringify(safe)]);
    this.database.flushNow();
    return { ...safe, hasApiKey: Boolean(next.apiKey) };
  }
}

export interface OverlayCaptureProtectionSettings {
  captureProtection: boolean;
}

export type TencentValidationStatus = "unverified" | "verified" | "failed";
export type AutomationMode = "AUTO" | "MANUAL";

export interface TencentValidationState {
  desktopShare: TencentValidationStatus;
  windowShare: TencentValidationStatus;
}

export class OverlaySettingsStore {
  private static readonly key = "overlay.captureProtection";
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
