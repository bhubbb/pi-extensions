/**
 * Multi-backend llama.cpp provider for pi.
 *
 * Auto-discovers models from one or more llama.cpp servers and registers them
 * as separate providers (`llama-cpp`, `llama-cpp-1`, `llama-cpp-2`, ...).
 *
 * Configuration priority: env vars → persisted config file → models.json fallback → defaults.
 *
 * Offline fallback: when the server is unreachable, reads `enabledModels` from
 * `settings.json` and registers matching models (e.g. `llama-cpp-1/unsloth/...`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfig } from "./config";
import { fetchModelList, fetchModelProps } from "./discovery";
import {
	getCurrentConfig,
	getModels,
	registerAllProviders,
	setCurrentConfig,
	setLastResult,
} from "./provider";
import { ModelLoadTracker, SseManager } from "./sse";
import { registerSetupCommand, registerStatusCommand, registerVersionCommand } from "./commands";
import type { DiscoveredModel, ResolvedBackend } from "./types";

// ---------------------------------------------------------------------------
// Settings.json fallback for offline model registration
// ---------------------------------------------------------------------------

function readSettingsEnabledModels(): string[] {
	try {
		const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
		if (!existsSync(settingsPath)) return [];
		const raw = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed.enabledModels) ? parsed.enabledModels : [];
	} catch {
		return [];
	}
}

/**
 * Convert enabledModels entries matching a provider prefix into DiscoveredModel objects.
 * Model format in settings.json: "llama-cpp-1/unsloth/model-name:quant"
 */
function modelsFromSettings(providerId: string): DiscoveredModel[] {
	const enabled = readSettingsEnabledModels();
	const prefix = `${providerId}/`;

	return enabled
		.filter((id) => typeof id === "string" && id.startsWith(prefix))
		.map((id) => {
			// Strip provider prefix to get the model name
			const modelName = id.slice(prefix.length);
			return {
				id,
				name: modelName,
				reasoning: false,
				input: ["text"] as const,
				contextWindow: 131_072,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		});
}

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

const sessionState = {
	// Per-backend SSE managers
	sseManagers: new Map<string, SseManager>(),
	// Per-backend model loading progress tracking
	loadTracker: new ModelLoadTracker(),
	// Timeout for clearing footer status
	statusTimeout: undefined as ReturnType<typeof setTimeout> | undefined,
	// Cache of per-model props discovery
	discoveredProps: new Map<string, { contextWindow: number; maxTokens: number; supportsThinking: boolean }>(),
	// Track which models are currently being discovered (prevent duplicate requests)
	pendingDiscovery: new Set<string>(),
};

function clearFooterStatusTimeout(): void {
	if (sessionState.statusTimeout !== undefined) {
		clearTimeout(sessionState.statusTimeout);
		sessionState.statusTimeout = undefined;
	}
}

// ---------------------------------------------------------------------------
// Backend discovery
// ---------------------------------------------------------------------------

/**
 * Discover models for a single backend and register it with pi.
 */
async function discoverBackend(
	pi: ExtensionAPI,
	backend: ResolvedBackend,
	providerModels: Record<string, DiscoveredModel[]>,
): Promise<{ source: string; modelCount: number; warnings?: string[] }> {
	try {
		const models = await fetchModelList(backend.baseUrl, backend.apiKey, backend.prefix);

		if (models.length === 0) {
			// Server returned empty — try offline fallback from enabledModels
			const fallbackModels = modelsFromSettings(backend.providerId);
			if (fallbackModels.length > 0) {
				providerModels[backend.providerId] = fallbackModels;
				console.log(`[llama-cpp] empty server response: registered ${fallbackModels.length} model(s) from enabledModels`);
				return { source: "offline-fallback", modelCount: fallbackModels.length };
			}
			return { source: "empty", modelCount: 0 };
		}

		providerModels[backend.providerId] = models;

		// Update SSE manager with new model list
		const existingSse = sessionState.sseManagers.get(backend.providerId);
		if (existingSse) {
			existingSse.updateModels(models);
		}

		// Track loaded model
		const loadedModel = models.find((m) => m.status?.value === "loaded");
		sessionState.loadTracker.setLoadedModel(backend.providerId, loadedModel?.id ?? null);

		setLastResult(backend.providerId, "live", models.length);

		return { source: "live", modelCount: models.length };
	} catch (err) {
		const msg = (err as Error).message;
		console.warn(`[llama-cpp] failed to reach ${backend.baseUrl}/models: ${msg}`);
		// Fallback: register models from settings.json enabledModels list
		const fallbackModels = modelsFromSettings(backend.providerId);
		if (fallbackModels.length > 0) {
			providerModels[backend.providerId] = fallbackModels;
			console.log(`[llama-cpp] offline fallback: registered ${fallbackModels.length} model(s) from enabledModels`);
			return { source: "offline-fallback", modelCount: fallbackModels.length };
		}
		return { source: "error", modelCount: 0, warnings: [msg] };
	}
}

/**
 * Discover props metadata for a specific model across all backends.
 */
async function discoverModelProps(
	pi: ExtensionAPI,
	providerId: string,
	modelId: string,
	ctx: Parameters<ExtensionAPI["on"]>[1],
	autoload = true,
): Promise<void> {
	const config = getCurrentConfig();
	if (!config) return;

	const backend = config.find((b) => b.providerId === providerId);
	if (!backend) return;

	// Prevent duplicate discovery requests
	const key = `${providerId}:${modelId}`;
	if (sessionState.pendingDiscovery.has(key)) return;
	sessionState.pendingDiscovery.add(key);

	const isLoaded = sessionState.loadTracker.isModelLoaded(providerId, modelId);

	// If already discovered and still loaded, skip
	const existing = sessionState.discoveredProps.get(key);
	if (existing && isLoaded) {
		// Apply cached metadata to the model
		const models = getModels(providerId);
		const model = models.find((m) => m.id === modelId);
		if (model) {
			model.contextWindow = existing.contextWindow;
			model.maxTokens = existing.maxTokens;
			if (existing.supportsThinking) {
				model.reasoning = true;
			}
		}
		sessionState.pendingDiscovery.delete(key);
		return;
	}

	try {
		const props = await fetchModelProps(backend.baseUrl, modelId, autoload);

		if (props) {
			sessionState.discoveredProps.set(key, props);

			// Update model metadata
			const models = getModels(providerId);
			const model = models.find((m) => m.id === modelId);
			if (model) {
				model.contextWindow = props.contextWindow;
				model.maxTokens = props.maxTokens;
				if (props.supportsThinking) {
					model.reasoning = true;
				}
			}

			// Re-register the provider with updated model
			const providerModels: Record<string, DiscoveredModel[]> = {};
			config.forEach((b) => {
				providerModels[b.providerId] = getModels(b.providerId);
			});
			registerAllProviders(pi, config, providerModels);
		}
	} finally {
		sessionState.pendingDiscovery.delete(key);
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = await resolveConfig();
	setCurrentConfig(config);

	// ---------------------------------------------------------------------------
	// Synchronous fallback registration (pre-bind queue)
	//
	// Register fallback models from settings.json enabledModels immediately,
	// during the factory body. During load, pi.registerProvider() queues to
	// pendingProviderRegistrations (flushed by bindCore) — this path does NOT
	// call assertActive(), so it works even if the runner is later invalidated.
	// This guarantees llama-cpp-* models are always available, even when the
	// server is offline or the async discovery races with session replacement.
	// ---------------------------------------------------------------------------
	const fallbackProviderModels: Record<string, DiscoveredModel[]> = {};
	for (const backend of config) {
		const fallback = modelsFromSettings(backend.providerId);
		if (fallback.length > 0) {
			fallbackProviderModels[backend.providerId] = fallback;
		}
	}
	if (Object.keys(fallbackProviderModels).length > 0) {
		try {
			registerAllProviders(pi, config, fallbackProviderModels);
			console.log(`[llama-cpp] registered ${Object.values(fallbackProviderModels).flat().length} fallback model(s) from enabledModels`);
		} catch {
			// Pre-bind queueing should not throw, but guard anyway.
		}
	}

	// ---------------------------------------------------------------------------
	// Register commands
	// ---------------------------------------------------------------------------
	registerStatusCommand(pi);
	registerVersionCommand(pi);
	registerSetupCommand(pi);

	// ---------------------------------------------------------------------------
	// Initial discovery (async — non-blocking)
	// ---------------------------------------------------------------------------
	let startupError: string | null = null;
	const providerModels: Record<string, DiscoveredModel[]> = {};

	(async () => {
		try {
			const results = await Promise.all(
				config.map((backend) => discoverBackend(pi, backend, providerModels)),
			);

			const anySuccess = results.some((r) => r.modelCount > 0);
			const warnings = results.filter((r) => r.warnings).flatMap((r) => r.warnings ?? []);

			if (anySuccess) {
				try {
					registerAllProviders(pi, config, providerModels);
				} catch (err) {
					// Context may be stale after reload/session replacement
					if (err instanceof Error && err.message.includes("stale after session replacement")) {
						console.warn(`[llama-cpp] provider registration skipped: context is stale`);
					} else {
						throw err;
					}
				}

					// Initialize SSE managers for backends that returned models
				config.forEach((backend) => {
					if (providerModels[backend.providerId] && providerModels[backend.providerId].length > 0) {
						sessionState.sseManagers.set(
							backend.providerId,
							new SseManager(backend.providerId, backend.baseUrl, providerModels[backend.providerId]),
						);
					}
				});
			} else {
				startupError = `No models found on ${config.length} backend(s)`;
			}

			if (warnings.length > 0) {
				console.warn(`[llama-cpp] warnings: ${warnings.join("; ")}`);
			}
		} catch (err) {
			startupError = err instanceof Error ? err.message : String(err);
			console.warn(`[llama-cpp] discovery failed: ${startupError}`);
		}
	})();

	// ---------------------------------------------------------------------------
	// Event handlers
	// ---------------------------------------------------------------------------

	pi.on("input", async (event) => {
		const trimmed = event.text.trim().toLowerCase();
		if (trimmed === "/model") {
			// Refresh all backends
			const providerModels: Record<string, DiscoveredModel[]> = {};
			const config = getCurrentConfig();
			if (config) {
				await Promise.all(
					config.map((backend) => discoverBackend(pi, backend, providerModels)),
				);
				if (Object.keys(providerModels).length > 0) {
					registerAllProviders(pi, config, providerModels);
				}
			}
		}
	});

	pi.on("model_select", (event, ctx) => {
		const providerId = event.model.provider;
		if (!providerId.startsWith("llama-cpp")) {
			return;
		}
		void discoverModelProps(pi, providerId, event.model.id, ctx, true);
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const modelId = (event.payload as { model?: unknown })?.model;
			if (typeof modelId === "string") {
				// Find which backend this request is for
				const activeModel = ctx.model;
				if (activeModel && activeModel.provider?.startsWith("llama-cpp")) {
					void discoverModelProps(pi, activeModel.provider, modelId, ctx, true);
				}
			}
		} catch (error) {
			// Session was replaced as the request fired; nothing to discover.
			if (!((error as Error).message.includes("stale after session replacement"))) {
				throw error;
			}
		}
	});

	pi.on("session_shutdown", () => {
		clearFooterStatusTimeout();
		// Close all SSE connections across all backends
		for (const sse of sessionState.sseManagers.values()) {
			sse.closeAll();
		}
		sessionState.sseManagers.clear();
		sessionState.discoveredProps.clear();
		sessionState.pendingDiscovery.clear();
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = getCurrentConfig();
		if (!config) return;

		// Re-register providers with the freshest model data we have. By
		// session_start the runner is active, so pi.registerProvider() works.
		// This picks up live-discovered models from the async IIFE if it has
		// completed, otherwise keeps the fallback models registered above.
		const allProviderModels: Record<string, DiscoveredModel[]> = {};
		let hasLive = false;
		for (const backend of config) {
			const models = getModels(backend.providerId);
			if (models && models.length > 0) {
				allProviderModels[backend.providerId] = models;
				if (models.some((m) => m.status?.value === "loaded" || (m as any)._live)) hasLive = true;
			} else {
				const fallback = modelsFromSettings(backend.providerId);
				if (fallback.length > 0) allProviderModels[backend.providerId] = fallback;
			}
		}
		if (Object.keys(allProviderModels).length > 0) {
			try {
				registerAllProviders(pi, config, allProviderModels);
			} catch {
				// Runner may still be binding; fallback registration from load still applies.
			}
		}

		const totalModels = config.reduce((sum, b) => sum + (getModels(b.providerId)?.length ?? 0), 0);
		if (totalModels > 0) {
			ctx.ui.notify(`[llama-cpp] ${totalModels} model(s) ready across ${config.length} backend(s)`, "success");
		} else if (startupError) {
			ctx.ui.notify(`[llama-cpp] Offline: ${startupError.slice(0, 80)}`, "warning");
		}
	});
}
