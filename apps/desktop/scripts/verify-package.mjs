import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const unpackedDirectory = process.env.ELECTRON_PACKAGE_DIR ?? join(process.cwd(), "apps", "desktop", "release", "win-unpacked");
const archive = join(unpackedDirectory, "resources", "app.asar");
const vadModel = join(unpackedDirectory, "resources", "vad", "silero_vad_16k_op15.onnx");
const classifierDirectory = join(unpackedDirectory, "resources", "question-classifier");
const classifierRequired = ["model.onnx", "labels.json", "artifact-manifest.json"];
const classifierOptional = ["metrics.json", "model-card.json"];
const unpackedRequired = [
  join(unpackedDirectory, "resources", "audio-sidecar", "interview-audio.exe"),
  join(unpackedDirectory, "resources", "capture-helper", "capture-helper.exe"),
  join(unpackedDirectory, "resources", "sql.js", "sql-wasm.wasm")
];
const archiveRequired = ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"];

function normalizeArchiveEntry(entry) {
  return entry.replace(/^[\\/]+/, "").replaceAll("\\", "/");
}

function archivePathForExtraction(entry) {
  return normalizeArchiveEntry(entry).replaceAll("/", sep);
}

for (const path of unpackedRequired) {
  if (!existsSync(path)) throw new Error(`Missing packaged runtime dependency: ${path}`);
}
if (!existsSync(archive)) throw new Error(`Missing packaged archive: ${archive}`);
if (!existsSync(vadModel)) throw new Error(`VAD_MODEL_PRESENT: Missing packaged Silero VAD model: ${vadModel}`);

const classifierManifestPath = join(classifierDirectory, "artifact-manifest.json");
for (const fileName of classifierRequired) {
  const path = join(classifierDirectory, fileName);
  if (!existsSync(path)) throw new Error(`Missing required classifier resource: ${path}`);
}
let classifierManifest;
try {
  classifierManifest = JSON.parse(readFileSync(classifierManifestPath, "utf8"));
} catch (error) {
  throw new Error(`Invalid question classifier artifact manifest: ${classifierManifestPath} (${String(error)})`);
}
if (classifierManifest?.schemaVersion !== 1 || !classifierManifest.files || typeof classifierManifest.files !== "object") {
  throw new Error(`Invalid question classifier artifact manifest schema: ${classifierManifestPath}`);
}
const classifierFiles = [...classifierRequired.filter((fileName) => fileName !== "artifact-manifest.json"), ...classifierOptional.filter((fileName) => existsSync(join(classifierDirectory, fileName)))];
for (const fileName of classifierFiles) {
  const path = join(classifierDirectory, fileName);
  const expected = classifierManifest.files[fileName];
  if (!expected) throw new Error(`Classifier manifest has no hash for packaged resource: ${fileName}`);
  const bytes = readFileSync(path);
  const minimumBytes = Number(expected.minBytes ?? (fileName === "model.onnx" ? 100_000 : 1));
  if (bytes.byteLength < minimumBytes) throw new Error(`Packaged classifier resource is too small: ${path} (${bytes.byteLength} bytes)`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== String(expected.sha256).toLowerCase()) throw new Error(`Packaged classifier SHA256 mismatch: ${fileName}; expected ${expected.sha256}, got ${hash}`);
}
let classifierLabels;
try {
  classifierLabels = JSON.parse(readFileSync(join(classifierDirectory, "labels.json"), "utf8"));
} catch (error) {
  throw new Error(`Packaged classifier labels JSON is invalid: ${String(error)}`);
}
if (!Array.isArray(classifierLabels) || classifierLabels.length !== 4 || new Set(classifierLabels).size !== 4 || !["QUESTION", "FOLLOW_UP", "STATEMENT", "OTHER"].every((label) => classifierLabels.includes(label))) {
  throw new Error(`Packaged classifier labels JSON is incomplete: ${JSON.stringify(classifierLabels)}`);
}
for (const fileName of classifierOptional) {
  const path = join(classifierDirectory, fileName);
  if (!existsSync(path)) continue;
  try { JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Packaged classifier JSON is invalid: ${fileName} (${String(error)})`); }
}

const archiveEntries = listPackage(archive, { isPack: false });
console.log("First packaged app.asar entries returned by listPackage():");
archiveEntries.slice(0, 20).forEach((entry, index) => console.log(`${index + 1}. ${entry}`));
const entriesByNormalizedPath = new Map(archiveEntries.map((entry) => [normalizeArchiveEntry(entry), entry]));
const forbiddenModelEntries = archiveEntries.filter((entry) => /(?:^|[\\/_.-])q8(?:[_.-]|$)/i.test(normalizeArchiveEntry(entry)));
if (forbiddenModelEntries.length > 0) throw new Error(`Forbidden q8 model entries found in app.asar: ${forbiddenModelEntries.join(", ")}`);
for (const entry of archiveRequired) {
  const normalizedEntry = normalizeArchiveEntry(entry);
  if (!entriesByNormalizedPath.has(normalizedEntry)) throw new Error(`Missing packaged app.asar entry: ${entry}`);
}

const bundledMain = extractFile(
  archive,
  archivePathForExtraction(entriesByNormalizedPath.get("out/main/index.js"))
).toString("utf8");
if (bundledMain.includes("preload/index.js")) throw new Error("Packaged main still references preload/index.js");

const rendererHtml = extractFile(
  archive,
  archivePathForExtraction(entriesByNormalizedPath.get("out/renderer/index.html"))
).toString("utf8");
if (!rendererHtml.includes('id="root"')) throw new Error("Packaged renderer entry does not contain the root mount point");

function listFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const packagedQ8Files = listFiles(join(unpackedDirectory, "resources", "local-asr-service"))
  .filter((path) => /(?:^|[\\/_.-])q8(?:[_.-]|$)/i.test(path));
if (packagedQ8Files.length > 0) throw new Error(`Forbidden q8 model files found in packaged resources: ${packagedQ8Files.join(", ")}`);

console.log(`Verified app.asar entries: ${archiveRequired.join(", ")}`);
console.log(`Verified packaged runtime dependencies: ${unpackedRequired.join(", ")}`);
console.log(`VAD_MODEL_PRESENT ${vadModel}`);
console.log(`Verified question classifier resources: ${classifierFiles.join(", ")}`);
console.log(`QUESTION_CLASSIFIER_ARTIFACT ${classifierManifest.artifactId ?? "unknown"}@${classifierManifest.artifactVersion ?? "unknown"}`);
console.log("Verified packaged resources do not contain q8 model files");
