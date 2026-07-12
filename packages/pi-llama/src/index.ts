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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	loadPersistedConfig,
	normalizeBaseUrl,
	pruneStaleEntries,
	resolveConfig,
	savePersistedConfig,
	serverCacheKey,
} from "./config";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	PROPS_NOT_LOADED_MAX_ATTEMPTS,
	PROPS_NOT_FOUND_MAX_ATTEMPTS,
	PROPS_SERVER_ERROR_MAX_ATTEMPTS,
	PROPS_AUTOLOAD_MAX_ATTEMPTS,
	PROPS_COOLDOWN_NOT_LOADED_MS,
	PROPS_COOLDOWN_SERVER_ERROR_MS,
	PROPS_COOLDOWN_NETWORK_ERROR_MS,
	PROPS_BACKOFF_NOT_LOADED_BASE_MS,
	PROPS_BACKOFF_NOT_FOUND_BASE_MS,
	PROPS_BACKOFF_SERVER_ERROR_BASE_MS,
	PROPS_BACKOFF_AUTOLOAD_BASE_MS,
	delayForAttempt,
} from "./constants";
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
import type { DiscoveredModel, FailedPropsEntry, PersistedConfig, PropsResult, ResolvedBackend } from "./types";

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
 *
 * When the server is offline, use the backend's configured contextWindow/maxTokens
 * (or constants defaults) instead of hard-coded guesses.
 */
function modelsFromSettings(
	providerId: string,
	defaultContextWindow: number,
	defaultMaxTokens: number,
): DiscoveredModel[] {
	const enabled = readSettingsEnabledModels();
	const prefix = `${providerId}/`;

	return enabled
		.filter((id) => typeof id === "string" && id.startsWith(prefix))
		.map((id) => {
			// Strip provider prefix to get the model name the server expects.
			// The request body `model` field must be the bare server id, NOT the
			// pi-scoped "llama-cpp-N/..." form — otherwise the server returns
			// 400 model not found. Live discovery already uses the bare id, so the
			// fallback must match it.
			const modelName = id.slice(prefix.length);
			return {
				id: modelName,
				name: modelName,
				reasoning: false, // discovered later via /props when server is available
				input: ["text"] as const,
				contextWindow: defaultContextWindow,
				maxTokens: defaultMaxTokens,
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
	// Cache of per-model props discovery (positive results)
	discoveredProps: new Map<string, { contextWindow: number; maxTokens: number; supportsThinking: boolean }>(),
	// Track which models are currently being discovered (prevent duplicate requests)
	pendingDiscovery: new Set<string>(),
	// Negative-result cache keyed by "providerId:modelId" (Change 4)
	failedProps: new Map<string, FailedPropsEntry>(),
	// Callback to clear failedProps when SSE reports a model as loaded
	onPropsCacheCleared: (() => {}) as (key: string) => void,
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
			const fallbackModels = modelsFromSettings(
				backend.providerId,
				backend.contextWindow,
				backend.maxTokens,
			);
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
		const fallbackModels = modelsFromSettings(
			backend.providerId,
			backend.contextWindow,
			backend.maxTokens,
		);
		if (fallbackModels.length > 0) {
			providerModels[backend.providerId] = fallbackModels;
			console.log(`[llama-cpp] offline fallback: registered ${fallbackModels.length} model(s) from enabledModels`);
			return { source: "offline-fallback", modelCount: fallbackModels.length };
		}
		return { source: "error", modelCount: 0, warnings: [msg] };
	}
}

/**
 * Apply discovered props metadata to the registered model and re-register.
 */
function applyPropsMetadata(
	key: string,
	props: { contextWindow: number; maxTokens: number; supportsThinking: boolean },
	config: ResolvedBackend[],
	pi: ExtensionAPI,
): void {
	sessionState.discoveredProps.set(key, props);

	// Update model metadata in-place
	const providerId = key.split(":")[0];
	const modelId = key.split(":").slice(1).join(":");
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

	// Persist to disk so /reload doesn't lose the discovery result.
	const backend = config.find((b) => b.providerId === providerId);
	if (backend) {
		void persistDiscoveredProps(backend.baseUrl, modelId, props, config);
	}
}

/**
 * Get the max retry attempts for a given variant and autoload flag.
 */
function getMaxAttempts(variant: PropsResult["variant"], autoload: boolean): number {
	switch (variant) {
		case "not-loaded":
			return autoload ? PROPS_AUTOLOAD_MAX_ATTEMPTS : PROPS_NOT_LOADED_MAX_ATTEMPTS;
		case "not-found":
			return PROPS_NOT_FOUND_MAX_ATTEMPTS;
		case "server-error":
			return PROPS_SERVER_ERROR_MAX_ATTEMPTS;
		case "error":
			return PROPS_SERVER_ERROR_MAX_ATTEMPTS;
		default:
			return 1; // ok, endpoint-missing: no retry
	}
}

/**
 * Get the backoff base delay for a given variant and autoload flag.
 */
function getBackoffBase(variant: PropsResult["variant"], autoload: boolean): number {
	switch (variant) {
		case "not-loaded":
			return autoload ? PROPS_BACKOFF_AUTOLOAD_BASE_MS : PROPS_BACKOFF_NOT_LOADED_BASE_MS;
		case "not-found":
			return PROPS_BACKOFF_NOT_FOUND_BASE_MS;
		case "server-error":
			return PROPS_BACKOFF_SERVER_ERROR_BASE_MS;
		case "error":
			return PROPS_BACKOFF_SERVER_ERROR_BASE_MS;
		default:
			return 0;
	}
}

/**
 * Get the cooldown duration (ms) for a given variant.
 * Doubled on the before_provider_request probe path (autoload=false).
 */
function getCooldown(variant: PropsResult["variant"], isProbePath: boolean): number {
	const base =
		variant === "not-loaded"
			? PROPS_COOLDOWN_NOT_LOADED_MS
			: variant === "server-error"
			? PROPS_COOLDOWN_SERVER_ERROR_MS
			: PROPS_COOLDOWN_NETWORK_ERROR_MS;
	return isProbePath ? base * 2 : base;
}

/**
 * Clear the failedProps cache entry for a model.
 */
function clearFailedPropsEntry(key: string): void {
	sessionState.failedProps.delete(key);
}

/**
 * Clear all failedProps entries for a specific backend (all models).
 */
function clearFailedPropsForBackend(providerId: string): void {
	for (const [k] of sessionState.failedProps) {
		if (k.startsWith(providerId + ":")) {
			sessionState.failedProps.delete(k);
		}
	}
}

/**
 * Discover props metadata for a specific model across all backends.
 * Owns the retry loop with bounded backoff (Change 3) and the negative
 * cache with cooldown (Change 4).
 */
async function discoverModelProps(
	pi: ExtensionAPI,
	providerId: string,
	modelId: string,
	ctx: ExtensionContext,
	autoload = true,
	options?: { clearCacheOnSelect?: boolean },
): Promise<void> {
	const config = getCurrentConfig();
	if (!config) return;

	const backend = config.find((b) => b.providerId === providerId);
	if (!backend) return;

	// Prevent duplicate discovery requests
	const key = `${providerId}:${modelId}`;
	if (sessionState.pendingDiscovery.has(key)) return;
	sessionState.pendingDiscovery.add(key);

	const isProbePath = !autoload; // before_provider_request uses autoload=false

	// Change 7: on model_select, clear the failedProps entry so the user's
	// explicit choice gets a fresh chance with autoload=true.
	if (options?.clearCacheOnSelect) {
		clearFailedPropsEntry(key);
	}

	const isLoaded = sessionState.loadTracker.isModelLoaded(providerId, modelId);

	// If already discovered and still loaded, skip
	const existing = sessionState.discoveredProps.get(key);
	if (existing && isLoaded) {
		// Apply cached metadata to the model
		applyPropsMetadata(key, existing, config, pi);
		sessionState.pendingDiscovery.delete(key);
		return;
	}

	// Change 4: check the negative cache before probing
	const failedEntry = sessionState.failedProps.get(key);
	if (failedEntry) {
		if (failedEntry.giveUp) {
			// Unrecoverable or budget exhausted — skip entirely
			sessionState.pendingDiscovery.delete(key);
			return;
		}
		if (failedEntry.cooldownUntil > Date.now()) {
			// Inside cooldown window — skip until it expires
			sessionState.pendingDiscovery.delete(key);
			return;
		}
		// Cooldown expired — allow re-probe below
	}

	// Change 6: id round-trip debug check (log only)
	const encoded = encodeURIComponent(modelId);
	if (encoded.includes("%25")) {
		console.debug(`[llama-cpp] /props id round-trip warning: double-encoded % in '${modelId}' → '${encoded}'`);
	}
	const decoded = decodeURIComponent(encoded);
	if (decoded !== modelId) {
		console.debug(`[llama-cpp] /props id round-trip warning: '${modelId}' decoded to '${decoded}'`);
	}

	// Change 3: retry loop with bounded backoff
	let lastResult: PropsResult | undefined;
	const abortController = new AbortController();

	try {
		// Determine initial variant for attempt budget from first fetch
		let currentVariant: PropsResult["variant"] = "error";

		for (let attempt = 0; ; attempt++) {
			// Determine max attempts based on the current variant
			const maxAttempts = getMaxAttempts(currentVariant, autoload);
			if (attempt >= maxAttempts) {
				break; // Budget exhausted
			}

			// Check abort signal (session replacement, shutdown)
			if (abortController.signal.aborted) {
				return;
			}

			// Backoff between attempts (not before the first)
			if (attempt > 0) {
				const baseDelay = getBackoffBase(currentVariant, autoload);
				const delay = delayForAttempt(attempt - 1, baseDelay);
				await new Promise((resolve) => setTimeout(resolve, delay));

				// Re-check abort after delay
				if (abortController.signal.aborted) {
					return;
				}
			}

			lastResult = await fetchModelProps(backend.baseUrl, modelId, autoload);

			if (lastResult.variant === "ok") {
				// Success — clear any prior failedProps entry and apply metadata
				clearFailedPropsEntry(key);
				applyPropsMetadata(key, lastResult, config, pi);
				sessionState.pendingDiscovery.delete(key);
				return;
			}

			// Non-retryable — stop immediately
			if (!lastResult.retryable) {
				break;
			}

			// Update variant for next iteration's attempt budget
			currentVariant = lastResult.variant;
		}
	} catch (err) {
		const msg = (err as Error).message;
		if (!msg.includes("stale after session replacement")) {
			console.warn(`[llama-cpp] /props retry loop error for ${modelId}: ${msg}`);
		}
	}

	// Change 4: write the negative cache entry on exhaustion
	if (lastResult) {
		const variant = lastResult.variant;
		const cooldown = getCooldown(variant, isProbePath);
		const giveUp = variant === "endpoint-missing" || variant === "not-found";

		sessionState.failedProps.set(key, {
			variant,
			giveUp,
			cooldownUntil: Date.now() + cooldown,
		});

		// Change 5: emit user notification after retries settle
		if (variant === "not-found" && giveUp) {
			ctx.ui.notify(
				`llama.cpp: model ${modelId} not found on ${providerId} after retries; metadata discovery skipped. Model still usable with default context window. Check /llama-status.`,
				"warning",
			);
		} else if (variant === "endpoint-missing") {
			ctx.ui.notify(
				`llama.cpp /props unavailable on ${providerId}; using default context window.`,
				"info",
			);
		} else if (variant === "server-error" && giveUp === false) {
			ctx.ui.notify(
				`llama.cpp /props for ${modelId} failed (${lastResult.status}) after retries; using default metadata. Will retry after cooldown.`,
				"warning",
			);
		}
		// not-loaded → never notify (benign, model is fine)
		// error (network) → console.warn only, no spam
	}

	sessionState.pendingDiscovery.delete(key);
}

// ---------------------------------------------------------------------------
// Persistent cache helpers
// ---------------------------------------------------------------------------

/**
 * Seed the in-memory discoveredProps cache from the persisted config on disk.
 * Translates the server-scoped key (baseUrl:modelId) into the provider-scoped
 * key (providerId:modelId) that the rest of the extension expects.
 */
function seedDiscoveredProps(
	persisted: PersistedConfig,
	config: ResolvedBackend[],
): void {
	for (const [key, entry] of Object.entries(persisted.discoveredProps ?? {})) {
		const { baseUrl, modelId } = parseServerCacheKeyFromKey(key);
		const backend = config.find((b) => normalizeBaseUrl(b.baseUrl) === baseUrl);
		if (!backend) continue; // stale — backend removed; pruned on next save
		const inMemoryKey = `${backend.providerId}:${modelId}`;
		sessionState.discoveredProps.set(inMemoryKey, {
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			supportsThinking: entry.supportsThinking,
		});
	}
}

/**
 * Parse a persisted cache key back into { baseUrl, modelId }.
 * Mirrors parseServerCacheKey from config.ts.
 */
function parseServerCacheKeyFromKey(key: string): { baseUrl: string; modelId: string } {
	const slashIndex = key.indexOf("//");
	if (slashIndex === -1) {
		const idx = key.indexOf(":");
		return { baseUrl: key.slice(0, idx), modelId: key.slice(idx + 1) };
	}
	const portColonIndex = key.indexOf(":", slashIndex + 2);
	if (portColonIndex === -1) {
		const idx = key.indexOf(":");
		return { baseUrl: key.slice(0, idx), modelId: key.slice(idx + 1) };
	}
	const modelColonIndex = key.indexOf(":", portColonIndex + 1);
	if (modelColonIndex === -1) {
		return { baseUrl: key, modelId: "" };
	}
	return { baseUrl: key.slice(0, modelColonIndex), modelId: key.slice(modelColonIndex + 1) };
}

/**
 * Persist newly discovered props to disk (fire-and-forget).
 * Re-reads the config to avoid clobbering concurrent changes, prunes stale
 * entries, and saves atomically.
 */
async function persistDiscoveredProps(
	baseUrl: string,
	modelId: string,
	props: { contextWindow: number; maxTokens: number; supportsThinking: boolean },
	config: ResolvedBackend[],
): Promise<void> {
	try {
		let persisted = await loadPersistedConfig();
		// Prune stale entries before saving
		persisted = pruneStaleEntries(persisted, config);
		const key = serverCacheKey(baseUrl, modelId);
		persisted.discoveredProps = {
			...(persisted.discoveredProps ?? {}),
			[key]: {
				key,
				contextWindow: props.contextWindow,
				maxTokens: props.maxTokens,
				supportsThinking: props.supportsThinking,
				discoveredAt: Date.now(),
			},
		};
		await savePersistedConfig(persisted);
	} catch (err) {
		// Fire-and-forget — log but don't block the request
		console.debug(
			`[llama-cpp] failed to persist discoveredProps for ${modelId}: ${(err as Error).message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const config = await resolveConfig();
	setCurrentConfig(config);

	// Seed the in-memory props cache from the persisted file so that models
	// show the correct context immediately after /reload, not after re-discovery.
	const persisted = await loadPersistedConfig();
	if (persisted.discoveredProps) {
		seedDiscoveredProps(persisted, config);
	}

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
		const fallback = modelsFromSettings(
			backend.providerId,
			backend.contextWindow,
			backend.maxTokens,
		);
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
						const sse = new SseManager(backend.providerId, backend.baseUrl, providerModels[backend.providerId]);
						// Change 4: when SSE reports a model as loaded, clear the stale
						// failedProps entry so the next probe is allowed.
						sse.setOnLoadedCallback((_providerId, _modelId) => {
							clearFailedPropsEntry(`${_providerId}:${_modelId}`);
						});
						sessionState.sseManagers.set(backend.providerId, sse);
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

	pi.on("model_select", async (event, ctx) => {
		const providerId = event.model.provider;
		if (!providerId.startsWith("llama-cpp")) {
			return;
		}
		// Await props discovery so the real contextWindow + maxTokens are
		// registered before the user sends their next message. Without awaiting,
		// the first request after selection goes out with pre-discovery defaults
		// (8192 ctx / 16384 out) and only gets corrected on request #2. autoload=true
		// here is intentional — selecting a model should load it.
		// Change 7: clear failedProps so the user's explicit choice gets a fresh attempt.
		await discoverModelProps(pi, providerId, event.model.id, ctx, true, { clearCacheOnSelect: true });
	});

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const modelId = (event.payload as { model?: unknown })?.model;
			if (typeof modelId === "string") {
				// Find which backend this request is for
				const activeModel = ctx.model;
				if (activeModel && activeModel.provider?.startsWith("llama-cpp")) {
					// autoload=false: metadata-only. autoload=true would force the
					// server to load a different model on every completion request,
					// racing the in-flight request and churning the server.
					void discoverModelProps(pi, activeModel.provider, modelId, ctx, false);
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
		sessionState.failedProps.clear();
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = getCurrentConfig();
		if (!config) return;

		// Change 4: clear failedProps on session_start — server may have
		// restarted, models reloaded, or URL may point at a fresh server.
		sessionState.failedProps.clear();

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
				const fallback = modelsFromSettings(
					backend.providerId,
					backend.contextWindow,
					backend.maxTokens,
				);
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

		// Re-probe cached entries to catch server n_ctx changes. Uses autoload=false
		// (metadata-only — no forced load). discoverModelProps will hit the
		// in-memory cache first (seeded above) and skip the network call if the
		// model is still loaded.
		for (const [inMemoryKey] of sessionState.discoveredProps) {
			const [pId, mId] = [inMemoryKey.split(":")[0], inMemoryKey.split(":").slice(1).join(":")];
			void discoverModelProps(pi, pId, mId, ctx, false);
		}

		const totalModels = config.reduce((sum, b) => sum + (getModels(b.providerId)?.length ?? 0), 0);
		if (totalModels > 0) {
			ctx.ui.notify(`[llama-cpp] ${totalModels} model(s) ready across ${config.length} backend(s)`, "success");
		} else if (startupError) {
			ctx.ui.notify(`[llama-cpp] Offline: ${startupError.slice(0, 80)}`, "warning");
		}
	});
}
