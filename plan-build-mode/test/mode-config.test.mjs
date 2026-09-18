import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
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
const jitiPath = join(
	piPackageDir,
	"node_modules",
	"jiti",
	"lib",
	"jiti.mjs",
);
const { createJiti } = await import(pathToFileURL(jitiPath).href);

const jiti = createJiti(import.meta.url);
const {
	mergeModeConfigs,
	normalizeModeConfig,
	serializeModeConfig,
	migrateLegacyConfig,
	getNamedPreset,
	setNamedPreset,
	deleteNamedPreset,
	setActivePreset,
} = await jiti.import("../mode-config.ts");

// --- Legacy format tests (backward compatibility) ---

test("normalizes plan/build model settings", () => {
	assert.deepEqual(
		normalizeModeConfig({
			plan: { provider: " openai-codex ", model: " gpt-5.2-codex ", thinkingLevel: "high" },
			build: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
		}),
		{
			plan: { provider: "openai-codex", model: "gpt-5.2-codex", thinkingLevel: "high" },
			build: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
		},
	);
});

test("ignores invalid values", () => {
	assert.deepEqual(
		normalizeModeConfig({
			plan: { provider: "", model: 123, thinkingLevel: "very-high" },
			build: "invalid",
		}),
		{},
	);
});

test("project config overrides global config per field (legacy)", () => {
	assert.deepEqual(
		mergeModeConfigs(
			{
				plan: { provider: "openai-codex", model: "gpt-5.2-codex", thinkingLevel: "high" },
				build: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
			},
			{
				plan: { thinkingLevel: "low" },
			},
		),
		{
			plan: { provider: "openai-codex", model: "gpt-5.2-codex", thinkingLevel: "low" },
			build: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
		},
	);
});

// --- Named preset tests ---

test("normalizes named presets", () => {
	assert.deepEqual(
		normalizeModeConfig({
			presets: {
				work: {
					plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
					build: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
				},
				cheap: {
					plan: { provider: "openai", model: "gpt-4o-mini", thinkingLevel: "low" },
				},
			},
			active: "work",
		}),
		{
			presets: {
				work: {
					plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
					build: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
				},
				cheap: {
					plan: { provider: "openai", model: "gpt-4o-mini", thinkingLevel: "low" },
				},
			},
			active: "work",
		},
	);
});

test("getNamedPreset retrieves a preset by name", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
		},
	});
	const preset = getNamedPreset(config, "work");
	assert.deepEqual(preset, {
		plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
	});
});

test("getNamedPreset returns undefined for missing preset", () => {
	const config = normalizeModeConfig({ presets: {} });
	assert.equal(getNamedPreset(config, "nonexistent"), undefined);
});

test("setNamedPreset adds a new preset", () => {
	const config = normalizeModeConfig({});
	const updated = setNamedPreset(config, "work", {
		plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
		build: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
	});
	assert.deepEqual(updated.presets?.work, {
		plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
		build: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
	});
});

test("setNamedPreset overwrites an existing preset", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "old", model: "old-model", thinkingLevel: "low" } },
		},
	});
	const updated = setNamedPreset(config, "work", {
		plan: { provider: "new", model: "new-model", thinkingLevel: "high" },
	});
	assert.deepEqual(updated.presets?.work, {
		plan: { provider: "new", model: "new-model", thinkingLevel: "high" },
	});
});

test("deleteNamedPreset removes a preset", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
			cheap: { plan: { provider: "openai", model: "gpt-4o-mini", thinkingLevel: "low" } },
		},
		active: "work",
	});
	const updated = deleteNamedPreset(config, "work");
	assert.equal(getNamedPreset(updated, "work"), undefined);
	assert.equal(updated.active, undefined); // active cleared since deleted preset was active
	assert.ok(updated.presets?.cheap);
});

test("deleteNamedPreset does not clear active if different preset deleted", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
			cheap: { plan: { provider: "openai", model: "gpt-4o-mini", thinkingLevel: "low" } },
		},
		active: "work",
	});
	const updated = deleteNamedPreset(config, "cheap");
	assert.equal(updated.active, "work"); // active not affected
	assert.equal(getNamedPreset(updated, "cheap"), undefined);
});

test("setActivePreset sets the active preset name", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
		},
	});
	const updated = setActivePreset(config, "work");
	assert.equal(updated.active, "work");
});

test("mergeModeConfigs merges presets and active", () => {
	const base = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
		},
		active: "work",
	});
	const override = normalizeModeConfig({
		presets: {
			cheap: { plan: { provider: "openai", model: "gpt-4o-mini", thinkingLevel: "low" } },
		},
		active: "cheap",
	});
	const merged = mergeModeConfigs(base, override);
	assert.ok(merged.presets?.work);
	assert.ok(merged.presets?.cheap);
	assert.equal(merged.active, "cheap"); // override wins
});

// --- Legacy migration tests ---

test("migrateLegacyConfig creates default preset from legacy plan/build", () => {
	const config = normalizeModeConfig({
		plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
		build: { provider: "openai", model: "gpt-4o", thinkingLevel: "high" },
	});
	const migrated = migrateLegacyConfig(config);
	assert.ok(migrated.presets?.default);
	assert.equal(migrated.active, "default");
	assert.deepEqual(migrated.presets.default.plan, { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" });
	assert.deepEqual(migrated.presets.default.build, { provider: "openai", model: "gpt-4o", thinkingLevel: "high" });
});

test("migrateLegacyConfig does not change config with existing presets", () => {
	const config = normalizeModeConfig({
		presets: {
			work: { plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" } },
		},
		active: "work",
	});
	const migrated = migrateLegacyConfig(config);
	assert.equal(migrated.active, "work");
	assert.ok(migrated.presets?.work);
});

test("migrateLegacyConfig returns empty config unchanged", () => {
	const config = normalizeModeConfig({});
	const migrated = migrateLegacyConfig(config);
	assert.deepEqual(migrated, {});
});

// --- Serialization tests ---

test("serializes named presets config", () => {
	const config = normalizeModeConfig({
		presets: {
			work: {
				plan: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "xhigh" },
				build: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "high" },
			},
		},
		active: "work",
	});
	const serialized = serializeModeConfig(config);
	const parsed = JSON.parse(serialized);
	assert.equal(parsed.active, "work");
	assert.ok(parsed.presets.work);
	assert.equal(parsed.presets.work.plan.provider, "anthropic");
});

test("serializes legacy plan/build config without losing settings", () => {
	const config = normalizeModeConfig({
		plan: { provider: "openai", model: "plan-model", thinkingLevel: "high" },
		build: { provider: "anthropic", model: "build-model", thinkingLevel: "medium" },
	});
	const parsed = JSON.parse(serializeModeConfig(config));

	assert.deepEqual(parsed, {
		plan: { provider: "openai", model: "plan-model", thinkingLevel: "high" },
		build: { provider: "anthropic", model: "build-model", thinkingLevel: "medium" },
	});
});

test("named presets are serialized without duplicate legacy settings", () => {
	const config = normalizeModeConfig({
		plan: { provider: "legacy", model: "legacy-plan" },
		presets: {
			work: { plan: { provider: "openai", model: "preset-plan" } },
		},
		active: "work",
	});
	const parsed = JSON.parse(serializeModeConfig(config));

	assert.equal(parsed.plan, undefined);
	assert.equal(parsed.active, "work");
	assert.equal(parsed.presets.work.plan.model, "preset-plan");
});
