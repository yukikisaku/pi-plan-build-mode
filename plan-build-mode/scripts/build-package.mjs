import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presetRoot = path.resolve(packageRoot, "../plan-build-preset");
const distRoot = path.join(packageRoot, "dist");

const modeFiles = [
  "agent-path.ts",
  "bash-mutation-guard.ts",
  "index.ts",
  "mode-config.ts",
  "mode-controller.ts",
  "model-picker-ui.ts",
  "plan-build-workflow.ts",
  "preset-bridge.ts",
  "reminder-tree-logic.ts",
];

const presetFiles = [
  "index.ts",
  "preset-ui.ts",
  "preset-workflow.ts",
];

await rm(distRoot, { recursive: true, force: true });
await mkdir(path.join(distRoot, "plan-build-mode"), { recursive: true });
await mkdir(path.join(distRoot, "plan-build-preset"), { recursive: true });

for (const file of modeFiles) {
  await cp(path.join(packageRoot, file), path.join(distRoot, "plan-build-mode", file));
}

await cp(
  path.join(packageRoot, "mode-prompts"),
  path.join(distRoot, "plan-build-mode", "mode-prompts"),
  { recursive: true },
);

for (const file of presetFiles) {
  await cp(path.join(presetRoot, file), path.join(distRoot, "plan-build-preset", file));
}
