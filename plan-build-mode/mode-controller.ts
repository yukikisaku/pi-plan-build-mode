import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { resolveAgentDir } from "./agent-path.js";
import { findDefiniteBashMutation } from "./bash-mutation-guard.js";
import { REMINDER_CUSTOM_TYPE_PREFIX } from "./reminder-tree-logic.js";
import {
	getNamedPreset,
	migrateLegacyConfig,
	mergeModeConfigs,
	normalizeModeConfig,
	serializeModeConfig,
	type ModeModelSettings,
	type ModeName,
	type ModeConfig,
} from "./mode-config.js";
import {
	isPlanBuildPresetEnabled,
	registerPlanBuildPresetBridge,
	unregisterPlanBuildPresetBridge,
	type PlanBuildPresetBridge,
} from "./preset-bridge.js";

const MODE_PROMPTS_DIR = join(import.meta.dirname, "mode-prompts");
const DEFAULT_PLAN_PROMPT_PATH = join(MODE_PROMPTS_DIR, "plan.md");
const DEFAULT_BUILD_PROMPT_PATH = join(MODE_PROMPTS_DIR, "build.md");
// ツール一覧はプロンプトキャッシュの一部なので、モード切替で一覧を変えない。
// edit / write は一覧に残し、実行直前の tool_call hook でブロックする。
// PowerShell は安全な読み取り/変更の判定器がないため plan 中はツール全体をブロックする。
// bash は読み取り用途を残し、明確に変更を行う操作だけを追加でブロックする。
// 1つでも禁止条件に一致すると複合コマンドを含むツール呼び出し全体が失敗するため、
// 調査用コマンドを不必要に妨げないようブロック対象は最小限にする。
const PLAN_BLOCKED_TOOLS = new Set(["edit", "write", "powershell"]);

// 固定のモード説明はhidden messageとして送る。
// system prompt経由ではpi-claude-bridgeに届かないため、会話メッセージとして配送する。
const CORE_REMINDER_CUSTOM_TYPE = `${REMINDER_CUSTOM_TYPE_PREFIX}core`;
const CORE_REMINDER = `
# Plan Mode

When plan mode is active, you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, and plan. Any modification attempt
is a critical violation. ZERO exceptions.

# Build Mode

When build mode is active, you are permitted to make file changes, run shell commands, and
utilize your arsenal of tools as needed to complete the requested implementation.
`.trim();

const PROJECT_CONFIG_RELATIVE_PATH = join(".pi", "plan-build-mode.json");
const LEGACY_PROJECT_CONFIG_RELATIVE_PATH = join(".pi", "plan-mode.json");

function getGlobalConfigPath(): string {
	return join(resolveAgentDir(), "plan-build-mode.json");
}

function getLegacyGlobalConfigPath(): string {
	return join(resolveAgentDir(), "plan-mode.json");
}

export interface ToolCallEventLike {
	toolName: string;
	input?: {
		command?: unknown;
	};
}

export interface ModeReminderMessage {
	message: {
		customType: string;
		content: string;
		display: false;
	};
}

export interface ReminderPresence {
	hasCore: boolean;
	lastMode: ModeName | undefined;
}

export interface ModeController {
	toggle(ctx: ExtensionContext): Promise<void>;
	handleInput(ctx: ExtensionContext): { action: "continue" } | { action: "handled" };
	coreReminder(ctx: ExtensionContext): ModeReminderMessage | undefined;
	modeReminder(ctx: ExtensionContext): ModeReminderMessage | undefined;
	handleToolCall(event: ToolCallEventLike): { block: true; reason: string } | undefined;
	handleModelSelect(ctx: ExtensionContext): void;
	handleSessionStart(ctx: ExtensionContext): Promise<void>;
	dispose(): void;
}

// Plan mode 用のモードプロンプトファイルのパスを取得する
function getPlanPromptPath(): string {
	const promptPath = process.env.PI_PLAN_MODE_PROMPT ?? process.env.PI_PLAN_MODE_SYSTEM_PROMPT;
	if (!promptPath) return DEFAULT_PLAN_PROMPT_PATH;
	return isAbsolute(promptPath) ? promptPath : join(MODE_PROMPTS_DIR, promptPath);
}

// Build mode 用のモードプロンプトファイルのパスを取得する
function getBuildPromptPath(): string {
	const promptPath = process.env.PI_BUILD_MODE_PROMPT ?? process.env.PI_BUILD_MODE_SYSTEM_PROMPT;
	if (!promptPath) return DEFAULT_BUILD_PROMPT_PATH;
	return isAbsolute(promptPath) ? promptPath : join(MODE_PROMPTS_DIR, promptPath);
}

// プロンプトファイルの読み込みエラーメッセージを作る
function formatPromptFileError(mode: "Plan" | "Build", path: string, reason: string): string {
	return `${mode} mode prompt ${reason}: ${path}. Create this file or set PI_${mode.toUpperCase()}_MODE_PROMPT.`;
}

// 指定されたモードのプロンプトファイルを読み込む
function loadModePrompt(mode: "Plan" | "Build", path: string): string {
	let prompt: string;
	try {
		prompt = readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(formatPromptFileError(mode, path, "file not found"));
	}

	if (!prompt) {
		throw new Error(formatPromptFileError(mode, path, "is empty"));
	}

	return prompt;
}

// Plan mode のプロンプトを読み込む
function loadPlanPrompt(): string {
	return loadModePrompt("Plan", getPlanPromptPath());
}

// Build mode のプロンプトを読み込む
function loadBuildPrompt(): string {
	return loadModePrompt("Build", getBuildPromptPath());
}

// Plan / Build のプロンプトファイルに問題がないか確認する
function getPromptFileErrors(): string[] {
	const errors: string[] = [];
	for (const loadPrompt of [loadPlanPrompt, loadBuildPrompt]) {
		try {
			loadPrompt();
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return errors;
}

// 指定された設定ファイルを読み込む
function loadConfigFile(path: string): ModeConfig {
	if (!existsSync(path)) return {};

	try {
		return normalizeModeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		throw new Error(`Plan mode config could not be loaded: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// グローバル設定とプロジェクト設定を読み込んで結合する
function loadModeConfig(cwd: string): ModeConfig {
	const legacyGlobalConfig = loadConfigFile(getLegacyGlobalConfigPath());
	const globalConfig = loadConfigFile(getGlobalConfigPath());
	const legacyProjectConfig = loadConfigFile(join(cwd, LEGACY_PROJECT_CONFIG_RELATIVE_PATH));
	const projectConfig = loadConfigFile(join(cwd, PROJECT_CONFIG_RELATIVE_PATH));
	return [globalConfig, legacyProjectConfig, projectConfig].reduce(
		(config, nextConfig) => mergeModeConfigs(config, nextConfig),
		legacyGlobalConfig,
	);
}

// 保存先として使う設定ファイルのパスを決める
function getWritableConfigPath(cwd: string): string {
	const projectPath = join(cwd, PROJECT_CONFIG_RELATIVE_PATH);
	if (existsSync(projectPath)) return projectPath;

	const legacyProjectPath = join(cwd, LEGACY_PROJECT_CONFIG_RELATIVE_PATH);
	if (existsSync(legacyProjectPath)) return legacyProjectPath;

	const globalConfigPath = getGlobalConfigPath();
	const legacyGlobalConfigPath = getLegacyGlobalConfigPath();
	if (existsSync(globalConfigPath)) return globalConfigPath;
	if (existsSync(legacyGlobalConfigPath)) return legacyGlobalConfigPath;
	return globalConfigPath;
}

// LLMへ実際に送られる会話経路から、reminderが残っているかを調べる。
// メモリ上の送信済みフラグでは、/fuck や /tree で発言を取り消したときに
// reminderが経路から外れたことに気づけないため、毎回セッションを見る。
function findReminderPresence(ctx: ExtensionContext): ReminderPresence {
	let hasCore = false;
	let lastMode: ModeName | undefined;

	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "custom_message") continue;

		if (entry.customType === CORE_REMINDER_CUSTOM_TYPE) {
			hasCore = true;
		} else if (entry.customType === `${REMINDER_CUSTOM_TYPE_PREFIX}plan`) {
			lastMode = "plan";
		} else if (entry.customType === `${REMINDER_CUSTOM_TYPE_PREFIX}build`) {
			lastMode = "build";
		}
	}

	return { hasCore, lastMode };
}

// Plan mode の設定をファイルに保存する
function saveModeConfig(cwd: string, config: ModeConfig): string {
	const path = getWritableConfigPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, serializeModeConfig(config), "utf8");
	return path;
}

// Plan mode 拡張の実行時処理を作成する
export function createModeController(pi: ExtensionAPI): ModeController {
	let planModeEnabled = false;
	let modeSessionActive = false;
	let modeConfig: ModeConfig = {};

	// plan-build-preset が有効な場合だけ active preset を考慮してモード設定を取得する
	function getEffectiveModeSettings(mode: ModeName): ModeModelSettings | undefined {
		if (isPlanBuildPresetEnabled()) {
			const activePreset = modeConfig.active ? getNamedPreset(modeConfig, modeConfig.active) : undefined;
			if (activePreset?.[mode]) return activePreset[mode];
		}
		return modeConfig[mode];
	}

	// モードに応じたモデルと思考レベルの設定を反映する
	async function applyModeModelSettings(mode: ModeName, ctx: ExtensionContext): Promise<void> {
		const settings = getEffectiveModeSettings(mode);
		if (!settings) return;

		if ((settings.provider && !settings.model) || (!settings.provider && settings.model)) {
			ctx.ui.notify(
				`Plan mode config: ${mode} needs both provider and model to switch model.`,
				"warning",
			);
		} else if (settings.provider && settings.model) {
			const model = ctx.modelRegistry.find(settings.provider, settings.model);
			if (!model) {
				ctx.ui.notify(
					`Plan mode config: model not found for ${mode}: ${settings.provider}/${settings.model}`,
					"warning",
				);
			} else {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(
						`Plan mode config: no API key for ${settings.provider}/${settings.model}`,
						"warning",
					);
				}
			}
		}

		if (settings.thinkingLevel) {
			pi.setThinkingLevel(settings.thinkingLevel);
		}
	}

	// 現在のモードをステータス表示に反映する
	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("0-plan-build-mode", ctx.ui.theme.fg("success", "⏸ plan"));
		} else {
			ctx.ui.setStatus("0-plan-build-mode", ctx.ui.theme.fg("error", "⏵⏵ build"));
		}
	}

	// 現在のモード名を返す
	function getCurrentMode(): ModeName {
		return planModeEnabled ? "plan" : "build";
	}

	const presetBridge: PlanBuildPresetBridge = {
		getConfig: () => modeConfig,
		setConfig: (config) => {
			modeConfig = config;
		},
		getCurrentMode,
		applyModeModelSettings,
		saveConfig: saveModeConfig,
		updateStatus,
	};
	registerPlanBuildPresetBridge(presetBridge);

	// Plan mode と Build mode を切り替える
	async function toggle(ctx: ExtensionContext): Promise<void> {
		planModeEnabled = !planModeEnabled;
		const mode = getCurrentMode();
		await applyModeModelSettings(mode, ctx);

		updateStatus(ctx);
	}

	// 入力前にプロンプトファイルの問題を確認する
	function handleInput(ctx: ExtensionContext): { action: "continue" } | { action: "handled" } {
		const promptFileErrors = getPromptFileErrors();
		if (promptFileErrors.length === 0) return { action: "continue" };

		ctx.ui.notify(promptFileErrors.join("\n"), "error");
		return { action: "handled" };
	}

	// 会話経路にcore reminderがないときだけ送る
	function coreReminder(ctx: ExtensionContext): ModeReminderMessage | undefined {
		if (!modeSessionActive) return undefined;
		if (findReminderPresence(ctx).hasCore) return undefined;

		return {
			message: {
				customType: CORE_REMINDER_CUSTOM_TYPE,
				content: CORE_REMINDER,
				display: false,
			},
		};
	}

	// 会話経路の最後のreminderが現在モードと違うときだけ送る
	function modeReminder(ctx: ExtensionContext): ModeReminderMessage | undefined {
		if (!modeSessionActive) return undefined;

		const mode = getCurrentMode();
		if (findReminderPresence(ctx).lastMode === mode) return undefined;

		return {
			message: {
				customType: `${REMINDER_CUSTOM_TYPE_PREFIX}${mode}`,
				content: planModeEnabled ? loadPlanPrompt() : loadBuildPrompt(),
				display: false,
			},
		};
	}

	// Plan mode 中に禁止されたツール呼び出しをブロックする
	function handleToolCall(event: ToolCallEventLike): { block: true; reason: string } | undefined {
		if (!planModeEnabled) return undefined;

		if (PLAN_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Plan modeでは変更につながる組み込みツールを実行できません。Build modeへ切り替えてください。",
			};
		}

		if (event.toolName === "bash" && typeof event.input?.command === "string") {
			const mutation = findDefiniteBashMutation(event.input.command);
			if (mutation) {
				return {
					block: true,
					reason: `Plan modeでは変更操作を含むbashコマンドを実行できません: ${mutation}`,
				};
			}
		}

		return undefined;
	}

	// モデル選択後にステータスを更新する
	function handleModelSelect(ctx: ExtensionContext): void {
		updateStatus(ctx);
	}

	// セッション開始時に Plan mode の初期設定を行う
	async function handleSessionStart(ctx: ExtensionContext): Promise<void> {
		modeSessionActive = ctx.hasUI;

		// UI がないセッション（subagent, RPC, print モード）では
		// plan/build モードを有効化しない。
		// さもないと subagent の session_start で強制的に plan モードになり、
		// edit/write がブロックされて実質的に実行不能になる。
		if (!modeSessionActive) return;

		planModeEnabled = true;
		try {
			const loadedConfig = loadModeConfig(ctx.cwd);
			modeConfig = isPlanBuildPresetEnabled() ? migrateLegacyConfig(loadedConfig) : loadedConfig;
		} catch (error) {
			modeConfig = {};
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		await applyModeModelSettings("plan", ctx);
		updateStatus(ctx);

		const promptFileErrors = getPromptFileErrors();
		if (promptFileErrors.length > 0) {
			ctx.ui.notify(promptFileErrors.join("\n"), "error");
		}
	}

	function dispose(): void {
		unregisterPlanBuildPresetBridge(presetBridge);
	}

	return {
		toggle,
		handleInput,
		coreReminder,
		modeReminder,
		handleToolCall,
		handleModelSelect,
		handleSessionStart,
		dispose,
	};
}
