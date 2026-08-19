import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const unpackedDirectory = join(process.cwd(), "apps", "desktop", "release", "win-unpacked");
const archive = join(unpackedDirectory, "resources", "app.asar");
const unpackedRequired = [
  join(unpackedDirectory, "resources", "audio-sidecar", "interview-audio.exe"),
  join(unpackedDirectory, "resources", "sql.js", "sql-wasm.wasm")
];
const archiveRequired = ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html"];

for (const path of unpackedRequired) {
  if (!existsSync(path)) throw new Error(`Missing packaged runtime dependency: ${path}`);
}
if (!existsSync(archive)) throw new Error(`Missing packaged archive: ${archive}`);

const entries = new Set(listPackage(archive, { isPack: false }));
for (const entry of archiveRequired) {
  if (!entries.has(entry)) throw new Error(`Missing packaged app.asar entry: ${entry}`);
}

const bundledMain = extractFile(archive, "out/main/index.js").toString("utf8");
if (bundledMain.includes("preload/index.js")) throw new Error("Packaged main still references preload/index.js");

const rendererHtml = extractFile(archive, "out/renderer/index.html").toString("utf8");
if (!rendererHtml.includes('id="root"')) throw new Error("Packaged renderer entry does not contain the root mount point");

console.log(`Verified app.asar entries: ${archiveRequired.join(", ")}`);
console.log(`Verified packaged runtime dependencies: ${unpackedRequired.join(", ")}`);
