import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-plan-build-mode-pack-"));

try {
  const packOutput = execFileSync(
    npmCommand,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", tempRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  const packResult = JSON.parse(packOutput);
  assert.equal(packResult.length, 1, "npm pack should produce exactly one tarball");

  const extractRoot = join(tempRoot, "extract");
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("tar", ["-xzf", packResult[0].filename, "-C", "extract"], {
    cwd: tempRoot,
    stdio: "pipe",
  });

  const packedRoot = join(extractRoot, "package");
  const manifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  const entries = [
    "./dist/plan-build-mode/index.ts",
    "./dist/plan-build-preset/index.ts",
  ];
  assert.deepEqual(manifest.pi?.extensions, entries, "manifest must expose both Pi extension entries");

  const requiredFiles = [
    "dist/plan-build-mode/index.ts",
    "dist/plan-build-mode/mode-controller.ts",
    "dist/plan-build-mode/bash-mutation-guard.ts",
    "dist/plan-build-mode/mode-prompts/plan.md",
    "dist/plan-build-mode/mode-prompts/build.md",
    "dist/plan-build-preset/index.ts",
    "dist/plan-build-preset/preset-ui.ts",
    "dist/plan-build-preset/preset-workflow.ts",
    "README.md",
    "LICENSE",
  ];
  for (const file of requiredFiles) {
    assert.ok(existsSync(join(packedRoot, file)), `packed file missing: ${file}`);
  }
  assert.equal(existsSync(join(packedRoot, "test")), false, "mode tests must not be packed");
  assert.equal(existsSync(join(packedRoot, "scripts")), false, "packaging scripts must not be packed");

  const globalRoot = execFileSync(npmCommand, ["root", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
  const packageNodeModules = join(packageRoot, "node_modules");
  const executableNodeModules = join(dirname(process.execPath), "node_modules");
  const piPackageDir = [packageNodeModules, executableNodeModules, globalRoot]
    .map((root) => join(root, "@earendil-works", "pi-coding-agent"))
    .find(existsSync);
  assert.ok(piPackageDir, "@earendil-works/pi-coding-agent is required for the smoke test");

  const loaderPath = join(piPackageDir, "dist", "core", "extensions", "loader.js");
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const entryPaths = entries.map((entry) => join(packedRoot, entry.slice(2)));
  const loaded = await loadExtensions(entryPaths, packedRoot);

  assert.deepEqual(loaded.errors, [], "Pi loader reported extension errors");
  assert.equal(loaded.extensions.length, 2, "Pi loader must load both packed entries");

  console.log("Packed Plan/Build mode and preset entries loaded successfully through Pi.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
