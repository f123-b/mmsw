import { createHash, createVerify } from "node:crypto";
import { createReadStream } from "node:fs";
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
