import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Sha256SignatureUpdateVerifier } from "./updater";

describe("secure update verification", () => {
  it("verifies artifact hash and RSA manifest signature", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-copilot-update-"));
    const artifact = join(directory, "app.exe");
    writeFileSync(artifact, "artifact");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const manifest = { version: "1.1.0", url: "https://example.test/app.exe", sha256: "" as string, signature: "" };
    const bytes = readFileSync(artifact);
    manifest.sha256 = createHash("sha256").update(bytes).digest("hex");
    const canonical = JSON.stringify({ version: manifest.version, url: manifest.url, sha256: manifest.sha256 });
    manifest.signature = sign("RSA-SHA256", Buffer.from(canonical), privateKey).toString("base64");
    const verifier = new Sha256SignatureUpdateVerifier();
    expect(await verifier.verifyArtifact(artifact, manifest.sha256)).toBe(true);
    expect(verifier.verifySignature(manifest, publicKey.export({ type: "pkcs1", format: "pem" }).toString())).toBe(true);
  });
});
