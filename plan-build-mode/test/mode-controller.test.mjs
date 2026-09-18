import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import Module from "node:module";
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

const home = mkdtempSync(join(tmpdir(), "plan-build-mode-controller-home-"));
delete process.env.HOME;
process.env.USERPROFILE = home;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const modePromptsDir = mkdtempSync(join(tmpdir(), "mode-prompts-"));
process.env.PI_PLAN_MODE_PROMPT = join(modePromptsDir, "plan.md");
process.env.PI_BUILD_MODE_PROMPT = join(modePromptsDir, "build.md");
writeFileSync(
  join(modePromptsDir, "plan.md"),
  "<system-reminder>\n# Plan\nDo not edit.\n</system-reminder>",
  "utf8",
);
writeFileSync(
  join(modePromptsDir, "build.md"),
  "<system-reminder>\n# Build\nYou may edit.\n</system-reminder>",
  "utf8",
);
writeFileSync(join(home, ".pi", "agent", "plan-mode.json"), JSON.stringify({
  plan: { provider: "anthropic", model: "claude-plan", thinkingLevel: "xhigh" },
  build: { provider: "anthropic", model: "claude-build", thinkingLevel: "high" },
}), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(piPackageDir, "dist", "index.js"),
  },
});
const { createModeController } = await jiti.import("../mode-controller.ts");
const { resolveAgentDir } = await jiti.import("../agent-path.ts");
const {
  enablePlanBuildPreset,
  disablePlanBuildPreset,
} = await jiti.import("../preset-bridge.ts");

function createFakePi() {
  const pi = {
    setModels: [],
    thinkingLevels: [],
    async setModel(model) { this.setModels.push(model); return true; },
    setThinkingLevel(level) { this.thinkingLevels.push(level); },
  };
  return pi;
}

function createFakeCtx(overrides = {}) {
  const notifications = [];
  const statuses = [];
  const entries = [];
  return {
    cwd: mkdtempSync(join(tmpdir(), "plan-build-mode-controller-cwd-")),
    hasUI: true,
    notifications,
    statuses,
    entries,
    sessionManager: {
      buildContextEntries() { return entries; },
    },
    modelRegistry: {
      find(provider, model) { return { provider, id: model }; },
    },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(key, value) { statuses.push({ key, value }); },
      theme: { fg(_color, value) { return value; } },
    },
    ...overrides,
  };
}

test("agent directory follows PI_CODING_AGENT_DIR, HOME, USERPROFILE precedence", () => {
  const piOverride = resolve("custom-pi-agent");
  const homeOverride = resolve("custom-home");
  const userProfileOverride = resolve("custom-user-profile");

  assert.equal(
    resolveAgentDir({
      PI_CODING_AGENT_DIR: piOverride,
      HOME: homeOverride,
      USERPROFILE: userProfileOverride,
    }),
    piOverride,
  );
  assert.equal(
    resolveAgentDir({ HOME: homeOverride, USERPROFILE: userProfileOverride }),
    join(homeOverride, ".pi", "agent"),
  );
  assert.equal(
    resolveAgentDir({ USERPROFILE: userProfileOverride }),
    join(userProfileOverride, ".pi", "agent"),
  );
});

test("agent directory resolution fails clearly when no base path is configured", () => {
  assert.throws(
    () => resolveAgentDir({}),
    /Set PI_CODING_AGENT_DIR, HOME, or USERPROFILE/,
  );
});

test("session start applies plan mode settings and status", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  assert.deepEqual(pi.setModels.at(-1), { provider: "anthropic", id: "claude-plan" });
  assert.equal(pi.thinkingLevels.at(-1), "xhigh");
  assert.deepEqual(ctx.statuses.at(-1), { key: "0-plan-build-mode", value: "⏸ plan" });
});

test("plan mode blocks write-capable built-in tools while leaving read-only tools available", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  for (const toolName of ["read", "grep", "find", "ls", "bash", "subagent", "web_search", "custom-tool"]) {
    assert.equal(modeController.handleToolCall({ toolName }), undefined);
  }
  for (const toolName of ["edit", "write", "powershell"]) {
    assert.equal(modeController.handleToolCall({ toolName })?.block, true);
  }
});

test("plan mode allows common compound bash inspection commands without matching words in arguments", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  const commands = [
    "rg 'rm|cp|git add|>' src | head -20",
    "git status && git diff | sed -n '1,120p'",
    "printf 'rm -rf is dangerous\\n'",
    "command -v rm",
    "find . -name rm -o -name cp",
    "cat missing 2>/dev/null || true",
    "echo visible 2>&1 && printf visible >/dev/tty",
    "[[ zebra > apple ]] && (( count > 1 ))",
    "git branch --show-current && git tag --list",
    "git branch --contains HEAD --format '%(refname)' && git tag --sort version:refname",
    "git config --get-regexp '^remote\\..*\\.url$' 'example'",
    "git reflog && git notes show HEAD && git bisect log",
    "npm list && curl -fsSL https://example.com",
    "curl -fsSL -o - https://example.com",
    "dd if=input.txt bs=1 count=10 2>/dev/null",
    "tee /dev/stderr < input.txt",
    "sudo cat /etc/hosts | xargs echo",
    "python -c 'print(\"write and rm are only text here\")'",
    "kill -0 12345",
    "kill -s 0 12345",
    "pkill --signal=SIG0 process-name",
    `node - <<'NODE'
const labels = items.map((item) => item.name);
console.log(labels);
NODE`,
    `python - <<'PY'
items = [1, 2, 3]
if len(items) >= 3:
    print(items)
PY`,
  ];

  for (const command of commands) {
    assert.equal(
      modeController.handleToolCall({ toolName: "bash", input: { command } }),
      undefined,
      command,
    );
  }
});

test("plan mode blocks only definite bash mutations, including one segment of a compound command", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  const commands = [
    "sed -n '1,20p' input.txt > output.txt",
    "test -n value > output.txt",
    "echo visible >& output.txt",
    "git status && cp source.txt destination.txt",
    "cat input.txt | tee output.txt",
    "sed -i 's/old/new/' file.txt",
    "perl -pi -e 's/old/new/' file.txt",
    "git add file.txt",
    "git branch new-branch",
    "git config user.name someone",
    "git reflog expire --all",
    "git notes add -m note HEAD",
    "npm install example",
    "apt install example",
    "find . -delete",
    "find . -exec rm {} \\;",
    "printf '%s\\0' output.txt | xargs -0 rm",
    "sudo -u root rm output.txt",
    "curl -o output.txt https://example.com",
    "dd if=input.txt of=output.txt",
    "sh -c 'touch output.txt'",
    `bash <<'SH'
rm output.txt
SH`,
    `env sh -s <<-'SH'
\trm output.txt
\tSH`,
    "kill 12345",
    "pkill -9 process-name",
    "echo ok >/dev/null && rm output.txt",
  ];

  for (const command of commands) {
    assert.equal(
      modeController.handleToolCall({ toolName: "bash", input: { command } })?.block,
      true,
      command,
    );
  }
});

test("toggle switches to build mode settings and unblocks all tools", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);
  assert.equal(modeController.handleToolCall({ toolName: "edit" })?.block, true);

  await modeController.toggle(ctx);

  assert.deepEqual(pi.setModels.at(-1), { provider: "anthropic", id: "claude-build" });
  assert.equal(pi.thinkingLevels.at(-1), "high");
  assert.deepEqual(ctx.statuses.at(-1), { key: "0-plan-build-mode", value: "⏵⏵ build" });
  assert.deepEqual(ctx.notifications, []);
  for (const toolName of ["bash", "powershell", "edit", "write", "custom-tool"]) {
    assert.equal(modeController.handleToolCall({ toolName }), undefined);
  }
  assert.equal(
    modeController.handleToolCall({ toolName: "bash", input: { command: "rm output.txt" } }),
    undefined,
  );
});

// 1ターン分のreminderを取り出し、送られたものを会話経路へ積む
function deliverReminders(modeController, ctx) {
  const delivered = [];
  for (const reminder of [modeController.coreReminder(ctx), modeController.modeReminder(ctx)]) {
    if (!reminder) continue;
    delivered.push(reminder.message);
    ctx.entries.push({
      type: "custom_message",
      customType: reminder.message.customType,
      content: reminder.message.content,
    });
  }
  return delivered;
}

test("core reminder と mode reminder を別々に送り、モード切替時だけ送り直す", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);
  const firstTurn = deliverReminders(modeController, ctx);
  assert.deepEqual(
    firstTurn.map((message) => message.customType),
    ["plan-build-mode-reminder:core", "plan-build-mode-reminder:plan"],
  );
  assert.match(firstTurn[0].content, /^# Plan Mode\n/);
  assert.equal(firstTurn[1].content, "<system-reminder>\n# Plan\nDo not edit.\n</system-reminder>");

  assert.deepEqual(deliverReminders(modeController, ctx), []);

  await modeController.toggle(ctx);
  const buildTurn = deliverReminders(modeController, ctx);
  assert.deepEqual(
    buildTurn.map((message) => message.customType),
    ["plan-build-mode-reminder:build"],
  );
  assert.equal(buildTurn[0].content, "<system-reminder>\n# Build\nYou may edit.\n</system-reminder>");

  assert.deepEqual(deliverReminders(modeController, ctx), []);

  // 会話経路にreminderが残っている限り、セッション再開でも送り直さない
  await modeController.handleSessionStart(ctx);
  assert.deepEqual(
    deliverReminders(modeController, ctx).map((message) => message.customType),
    ["plan-build-mode-reminder:plan"],
  );
});

test("発言を取り消して reminder が会話経路から外れたら送り直す", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);
  assert.equal(deliverReminders(modeController, ctx).length, 2);

  // /fuck などで直前の発言ごとreminderが経路から外れた状態
  ctx.entries.length = 0;

  assert.deepEqual(
    deliverReminders(modeController, ctx).map((message) => message.customType),
    ["plan-build-mode-reminder:core", "plan-build-mode-reminder:plan"],
  );
});

test("handleSessionStart does not enable plan mode when hasUI is false (subagent, RPC, print)", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx({ hasUI: false });
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  // model 設定は適用されない
  assert.equal(pi.setModels.length, 0);
  assert.equal(pi.thinkingLevels.length, 0);
  // plan mode が有効化されないのでステータスも設定されない
  assert.equal(ctx.statuses.length, 0);
  // edit / write はブロックされない
  assert.equal(modeController.handleToolCall({ toolName: "edit" }), undefined);
  assert.equal(modeController.handleToolCall({ toolName: "write" }), undefined);
  assert.equal(modeController.handleToolCall({ toolName: "bash" }), undefined);
  assert.equal(
    modeController.handleToolCall({ toolName: "bash", input: { command: "rm output.txt" } }),
    undefined,
  );
  assert.equal(modeController.handleToolCall({ toolName: "custom-tool" }), undefined);
  // UIなしセッションへはcore reminder・モードreminderを送らない
  assert.equal(modeController.coreReminder(ctx), undefined);
  assert.equal(modeController.modeReminder(ctx), undefined);
});

test("new project config overrides legacy global config", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(join(ctx.cwd, ".pi", "plan-build-mode.json"), JSON.stringify({
    plan: { provider: "openai", model: "project-plan", thinkingLevel: "low" },
  }), "utf8");
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  assert.deepEqual(pi.setModels.at(-1), { provider: "openai", id: "project-plan" });
  assert.equal(pi.thinkingLevels.at(-1), "low");
});

test("named presets are ignored when plan-build-preset is disabled", async () => {
  const pi = createFakePi();
  const ctx = createFakeCtx();
  mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
  writeFileSync(join(ctx.cwd, ".pi", "plan-build-mode.json"), JSON.stringify({
    presets: {
      project: {
        plan: { provider: "openai", model: "project-plan", thinkingLevel: "low" },
      },
    },
    active: "project",
  }), "utf8");
  const modeController = createModeController(pi);

  await modeController.handleSessionStart(ctx);

  assert.deepEqual(pi.setModels.at(-1), { provider: "anthropic", id: "claude-plan" });
  assert.equal(pi.thinkingLevels.at(-1), "xhigh");
});

test("named presets are applied when plan-build-preset is enabled", async () => {
  const token = Symbol("test-plan-build-preset");
  enablePlanBuildPreset(token);
  try {
    const pi = createFakePi();
    const ctx = createFakeCtx();
    mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
    writeFileSync(join(ctx.cwd, ".pi", "plan-build-mode.json"), JSON.stringify({
      presets: {
        project: {
          plan: { provider: "openai", model: "project-plan", thinkingLevel: "low" },
        },
      },
      active: "project",
    }), "utf8");
    const modeController = createModeController(pi);

    await modeController.handleSessionStart(ctx);

    assert.deepEqual(pi.setModels.at(-1), { provider: "openai", id: "project-plan" });
    assert.equal(pi.thinkingLevels.at(-1), "low");
  } finally {
    disablePlanBuildPreset(token);
  }
});
