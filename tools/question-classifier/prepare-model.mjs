import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const artifactDirectory = join(repositoryRoot, "apps", "desktop", "models", "question-classifier");
const manifestPath = join(artifactDirectory, "artifact-manifest.json");
const expectedLabels = new Set(["QUESTION", "FOLLOW_UP", "STATEMENT", "OTHER"]);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function prepare() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Question classifier artifact manifest is missing or invalid: ${manifestPath} (${String(error)})`);
  }
  if (manifest?.schemaVersion !== 1 || typeof manifest?.artifactId !== "string" || !manifest.files || typeof manifest.files !== "object") {
    throw new Error(`Question classifier artifact manifest has an unsupported schema: ${manifestPath}`);
  }

  const verified = {};
  for (const [fileName, expected] of Object.entries(manifest.files)) {
    const path = join(artifactDirectory, fileName);
    let fileStats;
    try {
      fileStats = await stat(path);
    } catch {
      throw new Error(`Question classifier artifact is missing: ${fileName}`);
    }
    if (!fileStats.isFile() || fileStats.size < Number(expected.minBytes ?? 1)) {
      throw new Error(`Question classifier artifact is too small: ${fileName} (${fileStats.size} bytes)`);
    }
    const actualHash = await sha256(path);
    if (actualHash !== String(expected.sha256).toLowerCase()) {
      throw new Error(`Question classifier artifact SHA256 mismatch: ${fileName}; expected ${expected.sha256}, got ${actualHash}`);
    }
    verified[fileName] = { bytes: fileStats.size, sha256: actualHash };
  }

  const labels = JSON.parse(await readFile(join(artifactDirectory, "labels.json"), "utf8"));
  if (!Array.isArray(labels) || labels.length !== expectedLabels.size || labels.some((label) => !expectedLabels.has(label))) {
    throw new Error("Question classifier labels.json is invalid or incomplete");
  }
  JSON.parse(await readFile(join(artifactDirectory, "metrics.json"), "utf8"));
  JSON.parse(await readFile(join(artifactDirectory, "model-card.json"), "utf8"));

  console.log(`QUESTION_CLASSIFIER_PREPARED ${JSON.stringify({ artifactId: manifest.artifactId, artifactVersion: manifest.artifactVersion, files: verified })}`);
}

prepare().catch((error) => {
  console.error(`QUESTION_CLASSIFIER_PREPARE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
