/**
 * Plan Build Mode Extension
 *
 * Starts in plan mode by default to prevent accidental code changes.
 * Shift+Tab to toggle between plan (read-only) and build (full access) mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createModeController } from "./mode-controller.js";

export default function planBuildModeExtension(pi: ExtensionAPI): void {
  // モード切替・ツール制限を担当するコントローラー
  const modeController = createModeController(pi);

  // --- ユーザー操作の受け口 ---

  // Shift+Tab で plan / build モードを切り替える
  pi.registerShortcut("shift+tab", {
    description: "Toggle plan/build mode",
    handler: async (ctx) => {
      await modeController.toggle(ctx);
    },
  });

  // --- セッション内イベントのフック ---

  // 入力時に plan/build プロンプトの不備を確認する
  pi.on("input", async (_event, ctx) => modeController.handleInput(ctx));

  // LLM送信直前に、会話経路から抜けているhidden reminderを送る
  pi.on("before_agent_start", async (_event, ctx) => modeController.coreReminder(ctx));
  pi.on("before_agent_start", async (_event, ctx) => modeController.modeReminder(ctx));

  // AIがツール呼び出す直前にフックしを発火。plan モードでは書き込みを遮断
  pi.on("tool_call", async (event) => modeController.handleToolCall(event));

  // モデル選択後に plan/build のステータス表示を更新する
  pi.on("model_select", async (_event, ctx) => {
    modeController.handleModelSelect(ctx);
  });

  // --- セッション開始時の初期化 ---

  // 開始・再開時は必ず plan モードで始め、誤変更を防ぐ
  pi.on("session_start", async (_event, ctx) => {
    await modeController.handleSessionStart(ctx);
  });

  // reload / 終了時に extension 間連携の参照を片付ける
  pi.on("session_shutdown", async () => {
    modeController.dispose();
  });
}
