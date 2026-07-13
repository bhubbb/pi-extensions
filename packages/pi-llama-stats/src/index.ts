/**
 * pi-llama-stats extension factory.
 *
 * Registers a shortcut (Ctrl+Shift+L) and a command (/llama-stats) that open
 * the StatsView overlay. Backends are re-resolved from disk on each invocation
 * so edits via /llama-setup are picked up immediately.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { resolveStatsBackends } from "./config";
import { StatsView } from "./view";

export default function (pi: ExtensionAPI): void {
  /**
   * Open the llama.cpp stats overlay.
   *
   * - Resolves backends from config (env var → pi-llama.json).
   * - If no backends, shows a notify and returns.
   * - Otherwise, opens a TUI overlay with the StatsView component.
   */
  const openStats = async (ctx: ExtensionContext): Promise<void> => {
    // Only works in TUI mode.
    if (!ctx.hasUI) {
      ctx.ui.notify("llama-stats requires TUI mode", "warning");
      return;
    }

    // Resolve backends (re-read from disk each time).
    const backends = await resolveStatsBackends();
    if (backends.length === 0) {
      ctx.ui.notify("No llama.cpp backends configured. Use /llama-setup.", "warning");
      return;
    }

    // Open the overlay — StatsView owns its own AbortController and refresh timer.
    // Wrap the done callback so dispose() is always called (even if the overlay
    // is closed by an external path that bypasses handleInput).
    await ctx.ui.custom(
      (tui, theme, _keybindings, done) => {
        // done expects a result argument; we pass null since the view doesn't return data.
        const originalDone = () => done(null);
        const view = new StatsView(backends, theme, tui, originalDone);
        // Safety net: wrap done to guarantee cleanup if bypassed.
        // dispose() is idempotent, so double-calls from handleInput are harmless.
        const wrappedDone = () => {
          view.dispose();
          originalDone();
        };
        view.onWrappedDone(wrappedDone);
        return view;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "70%",
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        },
      },
    );
  };

  // Register the keyboard shortcut.
  pi.registerShortcut(Key.ctrlShift("l"), {
    description: "Open llama.cpp server stats view",
    handler: openStats,
  });

  // Register the slash command (discoverable from /help).
  pi.registerCommand("llama-stats", {
    description: "Open llama.cpp server stats view",
    handler: async (_args, ctx) => openStats(ctx),
  });
}
