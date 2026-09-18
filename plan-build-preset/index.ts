import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	disablePlanBuildPreset,
	enablePlanBuildPreset,
	getPlanBuildPresetBridge,
} from "../plan-build-mode/preset-bridge.js";

export default function planBuildPresetExtension(pi: ExtensionAPI): void {
	const enabledToken = Symbol("plan-build-preset");
	enablePlanBuildPreset(enabledToken);

	pi.registerCommand("preset", {
		description: "Manage named presets for plan/build modes",
		handler: async (args, ctx) => {
			const bridge = getPlanBuildPresetBridge();
			if (!bridge) {
				ctx.ui.notify(
					"plan-build-mode extension が有効ではないため、/preset は使えません。pi config で plan-build-mode を有効にしてください。",
					"warning",
				);
				return;
			}

			const { createPresetWorkflow } = await import("./preset-workflow.js");
			const presetWorkflow = createPresetWorkflow(bridge);
			await presetWorkflow.handleCommand(args, ctx);
		},
	});

	pi.on("session_shutdown", async () => {
		disablePlanBuildPreset(enabledToken);
	});
}
