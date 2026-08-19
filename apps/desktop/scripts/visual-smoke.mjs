import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const iteration = (process.env.UI_ITERATION ?? "current").replace(/[^a-z0-9-]/gi, "-");

process.env.UI_VISUAL_SMOKE = "true";
process.env.UI_ARTIFACT_DIR ??= join(repositoryRoot, "artifacts", "ui");
process.env.UI_MAIN_NAME ??= `main-${iteration}.png`;
process.env.UI_OVERLAY_NAME ??= `overlay-${iteration}.png`;

await import("./production-smoke.mjs");
