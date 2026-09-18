import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";

import { THINKING_LEVELS, type ModeConfig, type ModeModelSettings, type ModeName, type ThinkingLevel } from "./mode-config.js";

export interface SelectableModel {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelPickerOptions {
	mode: ModeName;
	current: ModeModelSettings | undefined;
	allModels: SelectableModel[];
	scopedModels: SelectableModel[];
	initialThinkingLevel: ThinkingLevel;
}

function modelFullId(model: SelectableModel): string {
	return `${model.provider}/${model.id}`;
}

function settingsFullId(settings: ModeModelSettings | undefined): string | undefined {
	if (!settings?.provider || !settings.model) return undefined;
	return `${settings.provider}/${settings.model}`;
}

function formatModeSettings(settings: ModeModelSettings | undefined): string {
	if (!settings?.provider || !settings.model) return "(not set)";
	return `[${settings.provider}] ${settings.model} ${settings.thinkingLevel ?? "default"}`;
}

function nextThinkingLevel(current: ThinkingLevel, direction: 1 | -1): ThinkingLevel {
	const currentIndex = THINKING_LEVELS.indexOf(current);
	const safeIndex = currentIndex >= 0 ? currentIndex : THINKING_LEVELS.indexOf("high");
	const nextIndex = (safeIndex + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length;
	return THINKING_LEVELS[nextIndex];
}

function sortAllModels(models: SelectableModel[], currentModelId: string | undefined): SelectableModel[] {
	return [...models].sort((a, b) => {
		const aId = modelFullId(a);
		const bId = modelFullId(b);
		if (aId === currentModelId && bId !== currentModelId) return -1;
		if (aId !== currentModelId && bId === currentModelId) return 1;
		return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});
}

export type ModeOverviewResult = { action: "togglePreset" } | { action: "editMode"; mode: ModeName } | undefined;

export async function showModeOverview(ctx: ExtensionContext, config: ModeConfig): Promise<ModeOverviewResult> {
	const modes: ModeName[] = ["plan", "build"];
	const presetEnabled = config.presetEnabled === true;
	// index 0 = preset トグル行、index 1.. = 各モード行
	const rowCount = modes.length + 1;
	let selectedIndex = 0;

	return await ctx.ui.custom<ModeOverviewResult>((tui, theme, _kb, done) => ({
		render(width: number) {
			const lines: string[] = [];
			lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
			lines.push("");

			const presetSelected = selectedIndex === 0;
			const presetPrefix = presetSelected ? theme.fg("accent", "→ ") : "  ";
			const presetLabel = "preset:".padEnd(7, " ");
			const presetState = presetEnabled ? theme.fg("success", "● on") : theme.fg("muted", "● off");
			const presetText = presetSelected ? theme.fg("accent", presetLabel) : presetLabel;
			lines.push(truncateToWidth(`${presetPrefix}${presetText}${presetState}`, width));

			for (let i = 0; i < modes.length; i++) {
				const mode = modes[i]!;
				const selected = i + 1 === selectedIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const label = `${mode}:`.padEnd(7, " ");
				const body = formatModeSettings(config[mode]);
				const content = `${label}${body}`;
				// off の間は設定が効いていないことを dim 表示で示す
				const styled = selected ? theme.fg("accent", content) : presetEnabled ? content : theme.fg("dim", content);
				lines.push(truncateToWidth(`${prefix}${styled}`, width));
			}

			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "↑↓ Move • Enter Toggle/Edit • Esc Close"), width));
			lines.push("");
			lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
			return lines;
		},
		invalidate() {},
		handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				selectedIndex = selectedIndex === 0 ? rowCount - 1 : selectedIndex - 1;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.down)) {
				selectedIndex = selectedIndex === rowCount - 1 ? 0 : selectedIndex + 1;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (selectedIndex === 0) {
					done({ action: "togglePreset" });
					return;
				}
				done({ action: "editMode", mode: modes[selectedIndex - 1]! });
				return;
			}

			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(undefined);
			}
		},
	}));
}

export async function showModelPicker(
	ctx: ExtensionContext,
	options: ModelPickerOptions,
): Promise<ModeModelSettings | undefined> {
	if (options.allModels.length === 0) {
		ctx.ui.notify("No selectable models found", "warning");
		return undefined;
	}

	const currentModelId = settingsFullId(options.current);
	const allModels = sortAllModels(options.allModels, currentModelId);
	const scopedModels = options.scopedModels;

	return await ctx.ui.custom<ModeModelSettings | undefined>((tui, theme, _kb, done) => {
		const searchInput = new Input();
		let scope: "all" | "scoped" = scopedModels.length > 0 ? "scoped" : "all";
		let thinkingLevel = options.current?.thinkingLevel ?? options.initialThinkingLevel;
		let filteredModels: SelectableModel[] = [];
		let selectedIndex = 0;
		let focused = false;

		function activeModels(): SelectableModel[] {
			return scope === "scoped" ? scopedModels : allModels;
		}

		function currentModels(): SelectableModel[] {
			const query = searchInput.getValue();
			return query
				? fuzzyFilter(activeModels(), query, (model) => `${model.provider} ${model.id} ${model.name ?? ""} ${modelFullId(model)}`)
				: activeModels();
		}

		function refreshFilteredModels(options: { keepCurrent?: boolean } = {}): void {
			const selectedModelId = options.keepCurrent ? filteredModels[selectedIndex] && modelFullId(filteredModels[selectedIndex]) : undefined;
			filteredModels = currentModels();

			if (selectedModelId) {
				const nextIndex = filteredModels.findIndex((model) => modelFullId(model) === selectedModelId);
				if (nextIndex >= 0) {
					selectedIndex = nextIndex;
					return;
				}
			}

			selectedIndex = Math.min(selectedIndex, Math.max(0, filteredModels.length - 1));
		}

		function selectInitialModel(): void {
			refreshFilteredModels();
			const currentIndex = filteredModels.findIndex((model) => modelFullId(model) === currentModelId);
			selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		}

		function setScope(nextScope: "all" | "scoped"): void {
			if (scope === nextScope) return;
			scope = nextScope;
			refreshFilteredModels();
			const currentIndex = filteredModels.findIndex((model) => modelFullId(model) === currentModelId);
			selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		}

		function formatScopeText(): string {
			const allText = scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
			const scopedText = scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
			return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
		}

		function renderModelList(width: number): string[] {
			const lines: string[] = [];
			const maxVisible = 10;
			const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredModels.length - maxVisible));
			const endIndex = Math.min(startIndex + maxVisible, filteredModels.length);

			for (let i = startIndex; i < endIndex; i++) {
				const model = filteredModels[i];
				if (!model) continue;

				const isSelected = i === selectedIndex;
				const isCurrent = modelFullId(model) === currentModelId;
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const modelText = isSelected ? theme.fg("accent", model.id) : model.id;
				const providerBadge = theme.fg("muted", `[${model.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				lines.push(truncateToWidth(`${prefix}${modelText} ${providerBadge}${checkmark}`, width));
			}

			if (startIndex > 0 || endIndex < filteredModels.length) {
				lines.push(truncateToWidth(theme.fg("muted", `  (${selectedIndex + 1}/${filteredModels.length})`), width));
			}

			if (filteredModels.length === 0) {
				lines.push(truncateToWidth(theme.fg("muted", "  No matching models"), width));
			}

			return lines;
		}

		selectInitialModel();

		const component: Focusable & {
			render(width: number): string[];
			invalidate(): void;
			handleInput(data: string): void;
		} = {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				searchInput.focused = value;
			},
			render(width: number) {
				const lines: string[] = [];
				lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
				lines.push("");
				lines.push(truncateToWidth(theme.fg("accent", theme.bold(`Select ${options.mode} model`)), width));
				if (scopedModels.length > 0) {
					lines.push(truncateToWidth(formatScopeText(), width));
					lines.push(truncateToWidth(theme.fg("dim", "tab scope (all/scoped)"), width));
				} else {
					lines.push(truncateToWidth(theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."), width));
				}
				lines.push("");
				lines.push(...searchInput.render(width));
				lines.push("");
				lines.push(...renderModelList(width));
				lines.push("");
				lines.push(truncateToWidth(`${theme.fg("muted", "  thinking: ")}${theme.fg("accent", `◐ ${thinkingLevel}`)}${theme.fg("dim", "  ←/→ to adjust")}`, width));
				lines.push("");
				lines.push(truncateToWidth(theme.fg("dim", "↑↓ Move • Enter Save • Esc Back"), width));
				lines.push("");
				lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
				return lines;
			},
			invalidate() {
				searchInput.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.tab)) {
					if (scopedModels.length > 0) {
						setScope(scope === "all" ? "scoped" : "all");
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, Key.up)) {
					if (filteredModels.length > 0) {
						selectedIndex = selectedIndex === 0 ? filteredModels.length - 1 : selectedIndex - 1;
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, Key.down)) {
					if (filteredModels.length > 0) {
						selectedIndex = selectedIndex === filteredModels.length - 1 ? 0 : selectedIndex + 1;
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, Key.left)) {
					thinkingLevel = nextThinkingLevel(thinkingLevel, -1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.right)) {
					thinkingLevel = nextThinkingLevel(thinkingLevel, 1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const selected = filteredModels[selectedIndex];
					if (selected) {
						done({ provider: selected.provider, model: selected.id, thinkingLevel });
					}
					return;
				}

				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				}

				searchInput.handleInput(data);
				selectedIndex = 0;
				refreshFilteredModels();
				tui.requestRender();
			},
		};

		return component;
	});
}
