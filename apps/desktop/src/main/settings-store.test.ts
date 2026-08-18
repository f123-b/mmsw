import { describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database";
import { MemorySecretStore, ProviderConfigStore } from "./settings-store";

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
});
