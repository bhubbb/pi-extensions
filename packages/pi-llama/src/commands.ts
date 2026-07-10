/**
 * Commands for pi-llama multi-backend management.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CONFIG_PATH, loadPersistedConfig, savePersistedConfig } from "./config";
import { getCurrentConfig, getModels, getLastRefreshAt, setLastResult } from "./provider";
import type { DiscoveredModel } from "./types";

// ---------------------------------------------------------------------------
// /llama-status: Show backend configuration and model counts
// ---------------------------------------------------------------------------

export function registerStatusCommand(pi: ExtensionAPI): void {
	pi.registerCommand("llama-status", {
		description: "Show llama.cpp backend configuration and model status",
		handler: async (_args: string, ctx) => {
			const config = getCurrentConfig();
			if (!config || config.length === 0) {
				ctx.ui.notify("[llama-cpp] No backends configured", "warning");
				return;
			}

			const lines: string[] = [];
			lines.push(`[llama-cpp] ${config.length} backend(s) configured:`);

			config.forEach((backend, idx) => {
				const models = getModels(backend.providerId);
				const refreshAt = getLastRefreshAt(backend.providerId);
				const refreshTime = refreshAt ? new Date(refreshAt).toLocaleTimeString() : "never";

				const loaded = models.filter((m) => m.status?.value === "loaded");
				const suffix = loaded.length > 0 ? ` [${loaded.length} loaded]` : "";

				lines.push(
					ctx.ui.theme.fg("accent", `  [${idx}] ${backend.providerId}${suffix}`),
					ctx.ui.theme.fg("text", `       URL: ${backend.baseUrl}`),
					ctx.ui.theme.fg("text", `       Models: ${models.length}${models.length > 0 ? ` (${models.map((m) => m.name).join(", ")})` : ""}`),
					ctx.ui.theme.fg("text", `       Last refresh: ${refreshTime}`),
				);
			});

			ctx.ui.setWidget("llama-cpp-status", lines);
		},
	});
}

// ---------------------------------------------------------------------------
// /llama-version: Get llama.cpp server build info
// ---------------------------------------------------------------------------

export function registerVersionCommand(pi: ExtensionAPI): void {
	pi.registerCommand("llama-version", {
		description: "Get build info of a llama.cpp server",
		handler: async (args: string, ctx) => {
			const config = getCurrentConfig();
			if (!config || config.length === 0) {
				ctx.ui.notify("[llama-cpp] No backends configured", "warning");
				return;
			}

			// If index provided, use that backend; otherwise use first
			const idx = args ? parseInt(args, 10) : 0;
			const backend = idx >= 0 && idx < config.length ? config[idx] : config[0];

			const response = await fetch(`${backend.baseUrl.replace(/\/v1$/, "")}/props`);
			if (!response.ok) {
				ctx.ui.notify(`[llama-cpp] /props returned ${response.status}`, "error");
				return;
			}

			const data = await response.json();
			const match = data.build_info?.match(/^b([a-zA-Z0-9]+)-([a-zA-Z0-9]+)$/);

			if (match && match.length === 3) {
				ctx.ui.notify(`Build number: ${match[1]}, Commit hash: ${match[2]}`, "info");
			} else {
				ctx.ui.notify(`Build info: ${data.build_info ?? "(none)"}`, "info");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// /llama-setup: Interactive TUI setup wizard
// ---------------------------------------------------------------------------

export function registerSetupCommand(pi: ExtensionAPI): void {
	pi.registerCommand("llama-setup", {
		description: "Configure llama.cpp backends interactively",
		handler: async (_args: string, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("[llama-cpp] Setup wizard requires interactive TUI mode", "warning");
				return;
			}

			const persisted = await loadPersistedConfig();
			let backends = persisted.backends ?? [];

			ctx.ui.notify("[llama-cpp] Setup wizard started", "info");

			while (true) {
				const action = await ctx.ui.select(
					"llama.cpp setup",
					[
						...backends.map((_, i) => `${i}: ${backends[i].baseUrl}`),
						`ADD: Add new backend`,
						`DONE: Save and finish`,
					],
				);

				if (!action) return; // cancelled

				// Parse which action was selected
				if (action.includes("ADD")) {
					await addBackendWizard(ctx, backends);
				} else if (action.includes("DONE")) {
					const newConfig = { version: 1, backends };
					await savePersistedConfig(newConfig);
					ctx.ui.notify(`[llama-cpp] Saved ${backends.length} backend(s) to ${CONFIG_PATH}`, "success");
					return;
				} else {
					// Remove a backend (by index)
					const match = action.match(/^(\d+):/);
					if (match) {
						const idx = parseInt(match[1], 10);
						if (idx >= 0 && idx < backends.length) {
							const removed = backends.splice(idx, 1)[0];
							ctx.ui.notify(`[llama-cpp] Removed: ${removed.baseUrl}`, "info");
						}
					}
				}
			}
		},
	});
}

/** Interactive wizard to add a new backend. */
async function addBackendWizard(ctx: { ui: ExtensionAPI["ui"] }, backends: { baseUrl: string; apiKey?: string; api?: string }[]): Promise<void> {
	const baseUrl = await ctx.ui.input("Base URL:", "http://localhost:8080/v1");
	if (!baseUrl) return;

	const apiKey = await ctx.ui.input("API Key (optional, default: no-key):", "no-key");
	if (!apiKey) return;

	const api = await ctx.ui.select(
		"API type:",
		["openai-completions", "openai-responses", "anthropic-messages"],
	);

	backends.push({
		baseUrl,
		apiKey: apiKey || "no-key",
		api: api || "openai-completions",
	});

	ctx.ui.notify(`[llama-cpp] Added backend: ${baseUrl}`, "success");
}
