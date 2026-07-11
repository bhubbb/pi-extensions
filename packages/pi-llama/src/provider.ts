/**
 * Provider registration for pi-llama multi-backend support.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { DiscoveredModel, ResolvedBackend } from "./types";

// ---------------------------------------------------------------------------
// Mutable runtime state
// ---------------------------------------------------------------------------

const state = {
	config: null as ResolvedBackend[] | null,
	models: {} as Record<string, DiscoveredModel[]>,
	lastResult: {} as Record<string, { source: string; modelCount: number }>,
	lastRefreshAt: {} as Record<string, number>,
};

export function setCurrentConfig(config: ResolvedBackend[]): void {
	state.config = config;
	config.forEach((b) => {
		if (!state.models[b.providerId]) state.models[b.providerId] = [];
	});
}

export function getCurrentConfig(): ResolvedBackend[] | null {
	return state.config;
}

export function getModels(providerId: string): DiscoveredModel[] {
	return state.models[providerId] ?? [];
}

/**
 * Store the models registered for a backend.
 *
 * Why: getModels() previously always returned [] because nothing ever wrote
 * into state.models. session_start then re-registered stale fallback models
 * on top of the live-discovered ones, and discoverModelProps could never
 * enrich metadata. Mirror whatever is registered so those paths see reality.
 */
export function setModels(providerId: string, models: DiscoveredModel[]): void {
	state.models[providerId] = models;
}

export function getLastRefreshAt(providerId: string): number {
	return state.lastRefreshAt[providerId] ?? 0;
}

export function setLastResult(providerId: string, source: string, modelCount: number): void {
	state.lastResult[providerId] = { source, modelCount };
	state.lastRefreshAt[providerId] = Date.now();
}

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

/**
 * Register or update a single backend's provider in pi.
 */
export function registerBackendProvider(
	pi: ExtensionAPI,
	backend: ResolvedBackend,
	models: DiscoveredModel[],
): void {
	// Keep state.models in sync with what we register, so getModels() reflects
	// reality instead of always returning [] (see setModels docs).
	setModels(backend.providerId, models);

	pi.registerProvider(backend.providerId, {
		name: `llama.cpp${backend.providerId !== "llama-cpp" ? ` (${backend.baseUrl})` : ""}`,
		baseUrl: backend.baseUrl,
		apiKey: backend.apiKey,
		api: backend.api,
		authHeader: backend.authHeader,
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			compat: m.compat,
		})),
	});
}

/**
 * Register all backends' providers in pi (batch update).
 */
export function registerAllProviders(
	pi: ExtensionAPI,
	config: ResolvedBackend[],
	modelsMap: Record<string, DiscoveredModel[]>,
): void {
	config.forEach((backend) => {
		registerBackendProvider(pi, backend, modelsMap[backend.providerId] ?? []);
	});
}

// ---------------------------------------------------------------------------
// Model metadata enrichment
// ---------------------------------------------------------------------------

/**
 * Check if a model supports extended thinking based on its compat settings.
 */
export function modelSupportsThinking(model: DiscoveredModel): boolean {
	return model.reasoning;
}

/**
 * Build the thinkingLevelMap for llama.cpp's chat-template thinking control.
 * llama.cpp uses enable_thinking in chat_template_kwargs (boolean), so we expose
 * Pi's default off/medium toggle only.
 */
export function getThinkingLevelMap(): Record<string, string | null> {
	return {
		minimal: null,
		low: null,
		high: null,
		xhigh: null,
	};
}
