import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectories = [
  join(repositoryRoot, "node_modules", "electron"),
  join(repositoryRoot, "apps", "desktop", "node_modules", "electron")
];
const executableName = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app" : "electron";
const executablePath = packageDirectories.map((directory) => join(directory, "dist", executableName)).find((path) => existsSync(path));

if (executablePath) {
  console.log(`ELECTRON_RUNTIME_READY ${executablePath}`);
  process.exit(0);
}

const installScript = packageDirectories.map((directory) => join(directory, "install.js")).find((path) => existsSync(path));
if (!installScript) {
  throw new Error(`Electron install script is missing. Checked: ${packageDirectories.join(", ")}`);
}

console.log(`Installing Electron runtime with ${installScript}`);
const result = spawnSync(process.execPath, [installScript], { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Electron runtime installation failed with exit code ${result.status}`);

const installedPath = packageDirectories.map((directory) => join(directory, "dist", executableName)).find((path) => existsSync(path));
if (!installedPath) throw new Error(`Electron install completed without producing ${executableName}`);
console.log(`ELECTRON_RUNTIME_READY ${installedPath}`);
