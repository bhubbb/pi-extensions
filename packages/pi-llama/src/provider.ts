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
 * Build the thinkingLevelMap for a thinking-capable model.
 *
 * llama.cpp uses enable_thinking in chat_template_kwargs (boolean), so all
 * non-off levels map to the same "enabled" state. We pass all levels through
 * so pi can show the full range in /settings and the user picks their
 * preferred budget via thinkingBudgets. The compat.thinkingFormat="qwen-chat-template"
 * then converts this to chat_template_kwargs.enable_thinking=true/false.
 *
 * @internal exported for testing
 */
export function buildThinkingLevelMap(): Record<string, string> {
	return {
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
	};
}

/**
 * Build compat settings for a model, adding thinking format when supported.
 *
 * @internal exported for testing
 */
export function buildModelCompat(model: DiscoveredModel): Record<string, unknown> {
	const base = model.compat ?? {};
	if (model.reasoning) {
		// qwen-chat-template: tells pi to set chat_template_kwargs.enable_thinking
		// based on the active thinking level, and to preserve thinking blocks in
		// the response (matching llama.cpp's enable_thinking behavior).
		return { ...base, thinkingFormat: "qwen-chat-template" };
	}
	return base;
}

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
			// Include thinkingLevelMap and compat for thinking-capable models so
			// pi shows thinking levels in /settings and sends enable_thinking
			// via chat_template_kwargs.
			...(m.reasoning ? { thinkingLevelMap: buildThinkingLevelMap() } : {}),
			compat: buildModelCompat(m),
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
