import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import {
	THINKING_LEVELS,
	deleteNamedPreset,
	getNamedPreset,
	setActivePreset,
	setNamedPreset,
	type ModeModelSettings,
	type ModeName,
	type NamedPreset,
	type ModeConfig,
	type ThinkingLevel,
} from "../plan-build-mode/mode-config.js";
import { describePreset, showPresetListAction, type PresetListAction } from "./preset-ui.js";

export interface PresetWorkflowDeps {
	getConfig(): ModeConfig;
	setConfig(config: ModeConfig): void;
	getCurrentMode(): ModeName;
	applyModeModelSettings(mode: ModeName, ctx: ExtensionContext): Promise<void>;
	saveConfig(cwd: string, config: ModeConfig): string;
	updateStatus(ctx: ExtensionContext): void;
}

interface SelectableModel {
	provider: string;
	id: string;
	name?: string;
}

function modelFullId(model: SelectableModel): string {
	return `${model.provider}/${model.id}`;
}

export function createPresetWorkflow(deps: PresetWorkflowDeps) {
	async function getSelectableModels(ctx: ExtensionContext): Promise<SelectableModel[]> {
		const models = await ctx.modelRegistry.getAvailable() as SelectableModel[];
		const byId = new Map<string, SelectableModel>();

		if (ctx.model) {
			const currentModel = ctx.model as SelectableModel;
			byId.set(modelFullId(currentModel), currentModel);
		}

		for (const model of models) {
			byId.set(modelFullId(model), model);
		}

		return [...byId.values()].sort((a, b) => modelFullId(a).localeCompare(modelFullId(b)));
	}

	async function showModelSelector(ctx: ExtensionContext, mode: ModeName, currentModelId: string | undefined): Promise<string | undefined> {
		const models = await getSelectableModels(ctx);
		if (models.length === 0) {
			ctx.ui.notify("選択できるモデルが見つかりませんでした", "warning");
			return undefined;
		}

		return await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
			const container = new Container();
			const listContainer = new Container();
			const searchInput = new Input();
			let filteredModels = models;
			let selectedIndex = Math.max(0, models.findIndex((model) => modelFullId(model) === currentModelId));
			const maxVisible = 10;

			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`${mode} のモデルを選んでください`)), 0, 0));
			container.addChild(new Text(theme.fg("muted", "検索語を入力すると絞り込みます。空なら全件表示します。"), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(searchInput);
			container.addChild(new Spacer(1));
			container.addChild(listContainer);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", "↑↓ 移動 • Enter 選択 • Ctrl+C 検索クリア/キャンセル • Esc キャンセル"), 0, 0));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			function refreshList(): void {
				const query = searchInput.getValue();
				filteredModels = query
					? fuzzyFilter(models, query, (model) => `${model.provider} ${model.id} ${model.name ?? ""}`)
					: models;
				selectedIndex = Math.min(selectedIndex, Math.max(0, filteredModels.length - 1));

				listContainer.clear();
				if (filteredModels.length === 0) {
					listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
					return;
				}

				const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredModels.length - maxVisible));
				const endIndex = Math.min(startIndex + maxVisible, filteredModels.length);

				for (let i = startIndex; i < endIndex; i++) {
					const model = filteredModels[i];
					if (!model) continue;
					const isSelected = i === selectedIndex;
					const isCurrent = modelFullId(model) === currentModelId;
					const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
					const modelText = isSelected ? theme.fg("accent", model.id) : model.id;
					const providerBadge = theme.fg("muted", ` [${model.provider}]`);
					const currentBadge = isCurrent ? theme.fg("success", " current") : "";
					listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${currentBadge}`, 0, 0));
				}

				if (startIndex > 0 || endIndex < filteredModels.length) {
					listContainer.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filteredModels.length})`), 0, 0));
				}

				const selected = filteredModels[selectedIndex];
				if (selected) {
					listContainer.addChild(new Spacer(1));
					listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.name ?? selected.id}`), 0, 0));
				}
			}

			refreshList();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, "up")) {
						if (filteredModels.length > 0) {
							selectedIndex = selectedIndex === 0 ? filteredModels.length - 1 : selectedIndex - 1;
							refreshList();
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, "down")) {
						if (filteredModels.length > 0) {
							selectedIndex = selectedIndex === filteredModels.length - 1 ? 0 : selectedIndex + 1;
							refreshList();
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, "enter")) {
						const selected = filteredModels[selectedIndex];
						if (selected) done(modelFullId(selected));
						return;
					}

					if (matchesKey(data, Key.ctrl("c"))) {
						if (searchInput.getValue()) {
							searchInput.setValue("");
							selectedIndex = 0;
							refreshList();
							tui.requestRender();
						} else {
							done(undefined);
						}
						return;
					}

					if (matchesKey(data, "escape")) {
						done(undefined);
						return;
					}

					searchInput.handleInput(data);
					selectedIndex = 0;
					refreshList();
					tui.requestRender();
				},
			};
		});
	}

	async function activatePreset(name: string, ctx: ExtensionContext): Promise<void> {
		let config = deps.getConfig();
		const preset = getNamedPreset(config, name);
		if (!preset) {
			ctx.ui.notify(`Preset "${name}" not found.`, "error");
			return;
		}

		config = setActivePreset(config, name);
		deps.setConfig(config);
		const path = deps.saveConfig(ctx.cwd, config);

		const mode = deps.getCurrentMode();
		await deps.applyModeModelSettings(mode, ctx);

		ctx.ui.notify(`Activated preset "${name}". Saved to ${path}`, "info");
		deps.updateStatus(ctx);
	}

	async function selectModel(ctx: ExtensionContext, mode: ModeName, current: ModeModelSettings | undefined): Promise<ModeModelSettings | undefined> {
		const currentModelId = current?.provider && current?.model ? `${current.provider}/${current.model}` : undefined;
		const selectedModelId = await showModelSelector(ctx, mode, currentModelId);
		if (!selectedModelId) return undefined;
		const separatorIndex = selectedModelId.indexOf("/");
		if (separatorIndex === -1) {
			ctx.ui.notify(`モデルの形式が不正です: ${selectedModelId}`, "error");
			return undefined;
		}

		const thinkingChoice = await ctx.ui.select(
			`${mode} の thinking level を選んでください`,
			THINKING_LEVELS.map((level) => (level === current?.thinkingLevel ? `${level} (current)` : level)),
		);
		if (!thinkingChoice) return undefined;

		return {
			provider: selectedModelId.slice(0, separatorIndex),
			model: selectedModelId.slice(separatorIndex + 1),
			thinkingLevel: thinkingChoice.replace(/ \(current\)$/, "") as ThinkingLevel,
		};
	}

	async function editPresetFlow(ctx: ExtensionContext, existingPreset?: NamedPreset): Promise<NamedPreset | undefined> {
		const planResult = await selectModel(ctx, "plan", existingPreset?.plan);
		if (planResult === undefined) return undefined;

		const buildResult = await selectModel(ctx, "build", existingPreset?.build);
		if (buildResult === undefined) return undefined;

		return {
			plan: planResult,
			build: buildResult,
		};
	}

	async function saveAndApplyCurrentMode(ctx: ExtensionContext, config: ModeConfig): Promise<string> {
		deps.setConfig(config);
		const path = deps.saveConfig(ctx.cwd, config);
		const mode = deps.getCurrentMode();
		await deps.applyModeModelSettings(mode, ctx);
		deps.updateStatus(ctx);
		return path;
	}

	async function addPresetFlow(ctx: ExtensionContext): Promise<void> {
		const name = await ctx.ui.input("プリセット名を入力してください");
		if (!name || !name.trim()) return;

		const trimmedName = name.trim();
		const config = deps.getConfig();

		if (getNamedPreset(config, trimmedName)) {
			const overwrite = await ctx.ui.select(
				`プリセット "${trimmedName}" は既に存在します。上書きしますか？`,
				["はい", "いいえ"],
			);
			if (overwrite !== "はい") return;
		}

		await addPresetWithName(ctx, trimmedName);
	}

	async function addPresetWithName(ctx: ExtensionContext, name: string): Promise<void> {
		const config = deps.getConfig();
		const existingPreset = getNamedPreset(config, name);
		const preset = await editPresetFlow(ctx, existingPreset);
		if (!preset) return;

		const nextConfig = setActivePreset(setNamedPreset(config, name, preset), name);
		const path = await saveAndApplyCurrentMode(ctx, nextConfig);
		ctx.ui.notify(`プリセット "${name}" を保存しました: ${path}`, "info");
	}

	async function editPreset(ctx: ExtensionContext, name: string): Promise<void> {
		const config = deps.getConfig();
		const existingPreset = getNamedPreset(config, name);
		if (!existingPreset) {
			ctx.ui.notify(`プリセット "${name}" が見つかりません`, "error");
			return;
		}

		const preset = await editPresetFlow(ctx, existingPreset);
		if (!preset) return;

		let nextConfig = setNamedPreset(config, name, preset);
		deps.setConfig(nextConfig);
		const path = deps.saveConfig(ctx.cwd, nextConfig);

		if (nextConfig.active === name) {
			const mode = deps.getCurrentMode();
			await deps.applyModeModelSettings(mode, ctx);
		}

		ctx.ui.notify(`プリセット "${name}" を更新しました: ${path}`, "info");
		deps.updateStatus(ctx);
	}

	async function deletePreset(ctx: ExtensionContext, name: string): Promise<void> {
		const confirm = await ctx.ui.select(
			`プリセット "${name}" を削除しますか？`,
			["はい", "いいえ"],
		);
		if (confirm !== "はい") return;

		const currentConfig = deps.getConfig();
		const wasActive = currentConfig.active === name;
		let nextConfig = deleteNamedPreset(currentConfig, name);
		if (wasActive) {
			const fallbackName = Object.keys(nextConfig.presets ?? {})[0];
			if (fallbackName) {
				nextConfig = setActivePreset(nextConfig, fallbackName);
			}
		}
		deps.setConfig(nextConfig);
		const path = deps.saveConfig(ctx.cwd, nextConfig);
		if (wasActive) {
			await deps.applyModeModelSettings(deps.getCurrentMode(), ctx);
		}
		deps.updateStatus(ctx);
		ctx.ui.notify(`プリセット "${name}" を削除しました: ${path}`, "info");
	}

	async function handleListAction(ctx: ExtensionContext, action: PresetListAction): Promise<void> {
		switch (action.type) {
			case "activate":
				await activatePreset(action.name, ctx);
				return;
			case "edit":
				await editPreset(ctx, action.name);
				return;
			case "delete":
				await deletePreset(ctx, action.name);
				return;
			case "add":
				await addPresetFlow(ctx);
				return;
			case "cancel":
				return;
		}
	}

	async function showPresetList(ctx: ExtensionContext): Promise<void> {
		await handleListAction(ctx, await showPresetListAction(ctx, deps.getConfig()));
	}

	function showPresetListText(ctx: ExtensionContext): void {
		const presets = deps.getConfig().presets ?? {};
		const presetNames = Object.keys(presets);
		if (presetNames.length === 0) {
			ctx.ui.notify("プリセットがまだありません。/preset で追加してください。", "info");
			return;
		}

		const active = deps.getConfig().active;
		const lines = presetNames.map((name) => {
			const preset = presets[name];
			const marker = name === active ? "→ " : "  ";
			return `${marker}${name}: ${describePreset(preset)}`;
		});
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const parts = args.trim().split(/\s+/).filter(Boolean);

		if (parts.length === 0) {
			await showPresetList(ctx);
			return;
		}

		if (parts[0] === "list") {
			showPresetListText(ctx);
			return;
		}

		if (parts[0] === "add") {
			if (parts.length >= 2) {
				await addPresetWithName(ctx, parts.slice(1).join(" "));
			} else {
				await addPresetFlow(ctx);
			}
			return;
		}

		if (parts[0] === "edit" && parts.length >= 2) {
			await editPreset(ctx, parts.slice(1).join(" "));
			return;
		}

		if (parts[0] === "delete" && parts.length >= 2) {
			await deletePreset(ctx, parts.slice(1).join(" "));
			return;
		}

		const name = parts.join(" ");
		if (getNamedPreset(deps.getConfig(), name)) {
			await activatePreset(name, ctx);
			return;
		}

		ctx.ui.notify(
			`プリセット "${name}" が見つかりません。\n使い方: /preset, /preset list, /preset add [name], /preset edit <name>, /preset delete <name>, /preset <name>`,
			"warning",
		);
	}

	return {
		handleCommand,
		activatePreset,
		addPresetFlow,
		editPreset,
		deletePreset,
		showPresetList,
	};
}
