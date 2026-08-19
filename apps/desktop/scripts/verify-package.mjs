import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const unpackedDirectory = join(process.cwd(), "apps", "desktop", "release", "win-unpacked");
const archive = join(unpackedDirectory, "resources", "app.asar");
const unpackedRequired = [
  join(unpackedDirectory, "resources", "audio-sidecar", "interview-audio.exe"),
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

const archiveEntries = listPackage(archive, { isPack: false });
console.log("First packaged app.asar entries returned by listPackage():");
archiveEntries.slice(0, 20).forEach((entry, index) => console.log(`${index + 1}. ${entry}`));
const entriesByNormalizedPath = new Map(archiveEntries.map((entry) => [normalizeArchiveEntry(entry), entry]));
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

console.log(`Verified app.asar entries: ${archiveRequired.join(", ")}`);
console.log(`Verified packaged runtime dependencies: ${unpackedRequired.join(", ")}`);
