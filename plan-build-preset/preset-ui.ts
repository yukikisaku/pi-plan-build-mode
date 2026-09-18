import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { getNamedPreset, type NamedPreset, type ModeConfig } from "../plan-build-mode/mode-config.js";

export type PresetListAction =
	| { type: "activate"; name: string }
	| { type: "edit"; name: string }
	| { type: "delete"; name: string }
	| { type: "add" }
	| { type: "cancel" };

export function describeModeSettings(settings: NamedPreset["plan"]): string {
	if (!settings) return "default model/thinking";

	const parts: string[] = [];
	if (settings.provider && settings.model) parts.push(`${settings.provider}/${settings.model}`);
	if (settings.thinkingLevel) parts.push(`thinking:${settings.thinkingLevel}`);
	return parts.length > 0 ? parts.join(" ") : "default model/thinking";
}

export function describePreset(preset: NamedPreset): string {
	const planDesc = describeModeSettings(preset.plan);
	const buildDesc = describeModeSettings(preset.build);
	return `plan: ${planDesc} | build: ${buildDesc}`;
}

export async function showPresetListAction(ctx: ExtensionContext, config: ModeConfig): Promise<PresetListAction> {
	const presetNames = Object.keys(config.presets ?? {});

	if (presetNames.length === 0) {
		const shouldAdd = await ctx.ui.select(
			"プリセットがまだありません。追加しますか？",
			["はい", "いいえ"],
		);
		return shouldAdd === "はい" ? { type: "add" } : { type: "cancel" };
	}

	const items: SelectItem[] = presetNames.map((name) => {
		const preset = getNamedPreset(config, name)!;
		const isActive = name === config.active;
		return {
			value: name,
			label: isActive ? `→ ${name} (active)` : `  ${name}`,
			description: describePreset(preset),
		};
	});

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("プリセット一覧"))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter 選択 • e 編集 • d 削除 • a 追加 • esc キャンセル")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		function selectedName(): string | undefined {
			const idx = selectList.selectedIndex;
			return idx >= 0 && idx < items.length ? String(items[idx].value) : undefined;
		}

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "enter")) {
					const name = selectedName();
					if (name) done(name);
					return;
				}

				if (matchesKey(data, "escape")) {
					done(null);
					return;
				}

				if (data === "e") {
					const name = selectedName();
					if (name) done(`__edit__:${name}`);
					return;
				}

				if (data === "d") {
					const name = selectedName();
					if (name) done(`__delete__:${name}`);
					return;
				}

				if (data === "a") {
					done("__add__");
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!choice) return { type: "cancel" };
	if (choice === "__add__") return { type: "add" };
	if (choice.startsWith("__edit__:")) return { type: "edit", name: choice.slice("__edit__:".length) };
	if (choice.startsWith("__delete__:")) return { type: "delete", name: choice.slice("__delete__:".length) };
	return { type: "activate", name: choice };
}
