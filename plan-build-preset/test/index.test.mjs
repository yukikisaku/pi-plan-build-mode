import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import Module from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piPackageDir = process.env.PI_CODING_AGENT_DIR
  ? resolve(process.env.PI_CODING_AGENT_DIR)
  : join(
      execFileSync(npmCommand, ["root", "-g"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      }).trim(),
      "@earendil-works",
      "pi-coding-agent",
    );
const globalNodeModules = dirname(dirname(piPackageDir));
const jitiPath = join(piPackageDir, "node_modules", "jiti", "lib", "jiti.mjs");
const { createJiti } = await import(pathToFileURL(jitiPath).href);

process.env.NODE_PATH = [
  globalNodeModules,
  join(piPackageDir, "node_modules"),
  process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(piPackageDir, "dist", "index.js"),
    "@earendil-works/pi-tui": join(
      piPackageDir,
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "index.js",
    ),
  },
});
const { default: planBuildPresetExtension } = await jiti.import("../index.ts");
const { createPresetWorkflow } = await jiti.import("../preset-workflow.ts");

test("/preset warns when plan-build-mode bridge is unavailable", async () => {
  const registeredCommands = new Map();
  const handlers = new Map();
  planBuildPresetExtension({
    registerCommand(name, options) {
      registeredCommands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const notifications = [];
  await registeredCommands.get("preset").handler("", {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /plan-build-mode extension/);

  await handlers.get("session_shutdown")();
});

test("deleting the active preset activates the next preset and reapplies the current mode", async () => {
  let config = {
    presets: {
      work: {
        plan: { provider: "openai", model: "work-plan" },
        build: { provider: "openai", model: "work-build" },
      },
      fallback: {
        plan: { provider: "anthropic", model: "fallback-plan" },
        build: { provider: "anthropic", model: "fallback-build" },
      },
    },
    active: "work",
  };
  const saved = [];
  const appliedModes = [];
  const statuses = [];
  const notifications = [];
  const workflow = createPresetWorkflow({
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
    getCurrentMode: () => "plan",
    applyModeModelSettings: async (mode) => {
      appliedModes.push(mode);
    },
    saveConfig: (cwd, nextConfig) => {
      saved.push({ cwd, config: nextConfig });
      return `${cwd}/.pi/plan-build-mode.json`;
    },
    updateStatus: () => {
      statuses.push("updated");
    },
  });
  const ctx = {
    cwd: "project",
    ui: {
      select: async () => "はい",
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  await workflow.deletePreset(ctx, "work");

  assert.equal(config.active, "fallback");
  assert.equal(config.presets.work, undefined);
  assert.equal(saved.at(-1).config.active, "fallback");
  assert.deepEqual(appliedModes, ["plan"]);
  assert.equal(statuses.length, 1);
  assert.equal(notifications.at(-1).level, "info");
});
