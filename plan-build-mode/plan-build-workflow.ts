import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setModeSettings, type ModeConfig, type ModeName, type ThinkingLevel } from "./mode-config.js";
import { resolveAgentDir } from "./agent-path.js";
import { showModeOverview, showModelPicker, type SelectableModel } from "./model-picker-ui.js";

export interface PlanBuildWorkflowDeps {
	getConfig(): ModeConfig;
	setConfig(config: ModeConfig): void;
	isPresetEnabled(): boolean;
	setPresetEnabled(enabled: boolean, ctx: ExtensionContext): Promise<string>;
	getCurrentMode(): ModeName;
	getCurrentThinkingLevel(): ThinkingLevel;
	applyModeModelSettings(mode: ModeName, ctx: ExtensionContext): Promise<void>;
	saveConfig(config: ModeConfig): string;
	updateStatus(ctx: ExtensionContext): void;
}

function modelFullId(model: SelectableModel): string {
	return `${model.provider}/${model.id}`;
}

function toSelectableModel(model: SelectableModel): SelectableModel {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
	};
}

function dedupeModels(models: SelectableModel[]): SelectableModel[] {
	const byId = new Map<string, SelectableModel>();
	for (const model of models) {
		byId.set(modelFullId(model), model);
	}
	return [...byId.values()];
}

function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function patternMatchesModel(pattern: string, model: SelectableModel): boolean {
	const fullId = modelFullId(model);
	if (pattern.includes("*")) {
		const regex = wildcardToRegExp(pattern);
		return regex.test(fullId) || regex.test(model.id) || regex.test(model.provider);
	}

	if (pattern.includes("/")) return fullId === pattern;
	return model.id === pattern || model.provider === pattern;
}

const GLOBAL_SETTINGS_PATH = join(resolveAgentDir(), "settings.json");
const PROJECT_SETTINGS_RELATIVE_PATH = join(".pi", "settings.json");

function resolveScopedModels(patterns: string[] | undefined, allModels: SelectableModel[]): SelectableModel[] {
	if (!patterns || patterns.length === 0) return [];

	const selected = new Map<string, SelectableModel>();
	for (const rawPattern of patterns) {
		const trimmed = rawPattern.trim();
		if (!trimmed) continue;

		const isExclusion = trimmed.startsWith("-");
		const pattern = isExclusion ? trimmed.slice(1).trim() : trimmed;
		if (!pattern) continue;

		const matchedModels = allModels.filter((model) => patternMatchesModel(pattern, model));
		if (isExclusion) {
			for (const model of matchedModels) selected.delete(modelFullId(model));
		} else {
			for (const model of matchedModels) selected.set(modelFullId(model), model);
		}
	}

	return [...selected.values()];
}

function loadEnabledModelsFile(path: string): string[] | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { enabledModels?: unknown };
	if (!Array.isArray(parsed.enabledModels)) return undefined;
	return parsed.enabledModels.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function loadEnabledModels(cwd: string): string[] | undefined {
	const globalEnabledModels = loadEnabledModelsFile(GLOBAL_SETTINGS_PATH);
	const projectEnabledModels = loadEnabledModelsFile(join(cwd, PROJECT_SETTINGS_RELATIVE_PATH));
	return projectEnabledModels ?? globalEnabledModels;
}

async function getSelectableModels(ctx: ExtensionContext): Promise<{
	allModels: SelectableModel[];
	scopedModels: SelectableModel[];
}> {
	ctx.modelRegistry.refresh();

	const availableModels = (await ctx.modelRegistry.getAvailable()) as SelectableModel[];
	const allModels = dedupeModels([
		...(ctx.model ? [toSelectableModel(ctx.model as SelectableModel)] : []),
		...availableModels.map(toSelectableModel),
	]);

	let enabledModels: string[] | undefined;
	try {
		enabledModels = loadEnabledModels(ctx.cwd);
	} catch (error) {
		ctx.ui.notify(
			`Failed to load enabledModels: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}

	return {
		allModels,
		scopedModels: resolveScopedModels(enabledModels, allModels),
	};
}

function parseRequestedMode(args: string): ModeName | undefined {
	const trimmed = args.trim();
	if (trimmed === "plan" || trimmed === "build") return trimmed;
	return undefined;
}

function parseRequestedPresetState(args: string): boolean | undefined {
	const trimmed = args.trim();
	if (trimmed === "on") return true;
	if (trimmed === "off") return false;
	return undefined;
}

export function createPlanBuildWorkflow(deps: PlanBuildWorkflowDeps) {
	async function editMode(ctx: ExtensionCommandContext, mode: ModeName, config: ModeConfig): Promise<ModeConfig> {
		const { allModels, scopedModels } = await getSelectableModels(ctx);
		const selected = await showModelPicker(ctx, {
			mode,
			current: config[mode],
			allModels,
			scopedModels,
			initialThinkingLevel: deps.getCurrentThinkingLevel(),
		});
		if (!selected) return config;

		const nextConfig = setModeSettings(config, mode, selected);
		deps.setConfig(nextConfig);
		const path = deps.saveConfig(nextConfig);

		if (deps.getCurrentMode() === mode) {
			await deps.applyModeModelSettings(mode, ctx);
		}

		deps.updateStatus(ctx);
		ctx.ui.notify(`Saved ${mode} model settings: ${path}`, "info");
		return nextConfig;
	}

	async function togglePreset(ctx: ExtensionCommandContext, enabled: boolean): Promise<void> {
		const path = await deps.setPresetEnabled(enabled, ctx);
		ctx.ui.notify(`Saved: preset ${enabled ? "on" : "off"} (${path})`, "info");
	}

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		// 設定UIを含む plan-build-mode の操作はメインのTUIセッションだけで受け付ける。
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await ctx.waitForIdle();

		let config = deps.getConfig();
		const requestedMode = parseRequestedMode(args);
		if (requestedMode) {
			await editMode(ctx, requestedMode, config);
			return;
		}

		const requestedPresetState = parseRequestedPresetState(args);
		if (requestedPresetState !== undefined) {
			await togglePreset(ctx, requestedPresetState);
			return;
		}

		while (true) {
			const result = await showModeOverview(ctx, config);
			if (!result) return;

			if (result.action === "togglePreset") {
				await togglePreset(ctx, !deps.isPresetEnabled());
				config = deps.getConfig();
				continue;
			}

			config = await editMode(ctx, result.mode, config);
		}
	}

	return {
		handleCommand,
	};
}
