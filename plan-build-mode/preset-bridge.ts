import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ModeConfig, ModeName } from "./mode-config.js";

export interface PlanBuildPresetBridge {
	getConfig(): ModeConfig;
	setConfig(config: ModeConfig): void;
	getCurrentMode(): ModeName;
	applyModeModelSettings(mode: ModeName, ctx: ExtensionContext): Promise<void>;
	saveConfig(cwd: string, config: ModeConfig): string;
	updateStatus(ctx: ExtensionContext): void;
}

const BRIDGE_KEY = "__piPlanBuildModePresetBridge";
const ENABLED_TOKENS_KEY = "__piPlanBuildPresetEnabledTokens";

type GlobalWithPresetBridge = typeof globalThis & {
	[BRIDGE_KEY]?: PlanBuildPresetBridge;
	[ENABLED_TOKENS_KEY]?: Set<symbol>;
};

function bridgeGlobal(): GlobalWithPresetBridge {
	return globalThis as GlobalWithPresetBridge;
}

export function registerPlanBuildPresetBridge(bridge: PlanBuildPresetBridge): void {
	bridgeGlobal()[BRIDGE_KEY] = bridge;
}

export function unregisterPlanBuildPresetBridge(bridge: PlanBuildPresetBridge): void {
	const state = bridgeGlobal();
	if (state[BRIDGE_KEY] === bridge) {
		delete state[BRIDGE_KEY];
	}
}

export function getPlanBuildPresetBridge(): PlanBuildPresetBridge | undefined {
	return bridgeGlobal()[BRIDGE_KEY];
}

function enabledTokens(): Set<symbol> {
	const state = bridgeGlobal();
	state[ENABLED_TOKENS_KEY] ??= new Set<symbol>();
	return state[ENABLED_TOKENS_KEY];
}

export function enablePlanBuildPreset(token: symbol): void {
	enabledTokens().add(token);
}

export function disablePlanBuildPreset(token: symbol): void {
	enabledTokens().delete(token);
}

export function isPlanBuildPresetEnabled(): boolean {
	return enabledTokens().size > 0;
}
