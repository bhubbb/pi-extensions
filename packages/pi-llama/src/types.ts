/**
 * Type definitions for pi-llama multi-backend support.
 */

/** Configuration for a single llama.cpp backend/server. */
export interface LlamaBackendConfig {
	/** API endpoint URL (e.g., http://localhost:8080/v1). */
	baseUrl: string;
	/** API key (optional — llama.cpp may not require one). */
	apiKey?: string;
	/** API type for streaming. Defaults to "openai-completions". */
	api?: string;
	/** If true, sends Authorization: Bearer header. */
	authHeader?: boolean;
	/** Prefix to strip from model names during display. */
	prefix?: string;
}

/** Shape of the JSON file persisted to disk (~/.pi/agent/pi-llama.json). */
export interface PersistedConfig {
	/** Config version for future migration. */
	version?: number;
	/** List of llama.cpp backends to discover and register. */
	backends?: LlamaBackendConfig[];
}

/** Resolved backend config with defaults filled in. */
export interface ResolvedBackend {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	authHeader: boolean;
	prefix: string;
}

/** Runtime discovery result for a single backend. */
export interface BackendDiscoveryResult {
	providerId: string;
	source: "live" | "cache-fresh" | "cache-stale";
	models: DiscoveredModel[];
	warnings?: string[];
}

/** A discovered model with normalized Pi provider metadata. */
export interface DiscoveredModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
	status?: { value: string };
}
