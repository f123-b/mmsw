import { createHash, createVerify } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeUpdate, type UpdateManifest } from "@interview-copilot/shared";

export interface UpdateVerifier {
  verifyArtifact(path: string, expectedSha256: string): Promise<boolean>;
  verifySignature(manifest: UpdateManifest, publicKeyPem: string): boolean;
}

function canonicalManifest(manifest: UpdateManifest): string {
  return JSON.stringify({ version: manifest.version, url: manifest.url, sha256: manifest.sha256.toLowerCase() });
}

export class Sha256SignatureUpdateVerifier implements UpdateVerifier {
  verifyArtifact(path: string, expectedSha256: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex") === expectedSha256.toLowerCase()));
    });
  }

  verifySignature(manifest: UpdateManifest, publicKeyPem: string): boolean {
    if (!isSafeUpdate("0.0.0", manifest)) return false;
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(canonicalManifest(manifest));
      verifier.end();
      return verifier.verify(publicKeyPem, Buffer.from(manifest.signature, "base64"));
    } catch {
      return false;
    }
  }
}

export interface ReadyUpdate {
  status: "ready_to_install";
  version: string;
  artifactPath: string;
  manifest: UpdateManifest;
}

export class UpdateService {
  constructor(private readonly verifier: UpdateVerifier, private readonly fetcher: typeof fetch = fetch) {}

  async checkAndDownload(currentVersion: string, manifestUrl: string, publicKeyPem: string, temporaryDirectory: string): Promise<ReadyUpdate | undefined> {
    const manifestResponse = await this.fetcher(manifestUrl);
    if (!manifestResponse.ok) throw new Error(`Update manifest request failed: HTTP ${manifestResponse.status}`);
    const manifest = await manifestResponse.json() as UpdateManifest;
    if (!isSafeUpdate(currentVersion, manifest) || !this.verifier.verifySignature(manifest, publicKeyPem)) throw new Error("Update manifest failed validation");
    const artifactResponse = await this.fetcher(manifest.url);
    if (!artifactResponse.ok) throw new Error(`Update artifact request failed: HTTP ${artifactResponse.status}`);
    const bytes = new Uint8Array(await artifactResponse.arrayBuffer());
    await mkdir(temporaryDirectory, { recursive: true });
    const artifactPath = join(temporaryDirectory, `interview-copilot-${manifest.version}.installer`);
    await writeFile(artifactPath, bytes);
    if (!await this.verifier.verifyArtifact(artifactPath, manifest.sha256)) {
      await unlink(artifactPath).catch(() => undefined);
      throw new Error("Update artifact hash verification failed");
    }
    return { status: "ready_to_install", version: manifest.version, artifactPath, manifest };
  }
}
