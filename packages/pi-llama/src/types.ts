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
	/** Default context window for offline fallback (when /v1/models meta.n_ctx is missing). Defaults to 8192. */
	contextWindow?: number;
	/** Default max output tokens for offline fallback. Defaults to 16384. */
	maxTokens?: number;
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
	/** Default context window for offline fallback. */
	contextWindow: number;
	/** Default max output tokens for offline fallback. */
	maxTokens: number;
}

/** Runtime discovery result for a single backend. */
export interface BackendDiscoveryResult {
	providerId: string;
	source: "live" | "cache-fresh" | "cache-stale";
	models: DiscoveredModel[];
	warnings?: string[];
}

// ---------------------------------------------------------------------------
// /props discovery result variants (Change 2)
// ---------------------------------------------------------------------------

/**
 * Typed result from `fetchModelProps`. Each variant carries a `retryable`
 * hint so the caller knows whether to retry.
 */
export type PropsResult =
	| PropsOk
	| PropsNotLoaded
	| PropsNotFound
	| PropsEndpointMissing
	| PropsServerError
	| PropsError;

export interface PropsOk {
	variant: "ok";
	retryable: false;
	contextWindow: number;
	maxTokens: number;
	supportsThinking: boolean;
}

export interface PropsNotLoaded {
	variant: "not-loaded";
	retryable: true;
	status: number;
	errorMessage: string;
}

export interface PropsNotFound {
	variant: "not-found";
	retryable: true;
	status: number;
	errorMessage: string;
}

export interface PropsEndpointMissing {
	variant: "endpoint-missing";
	retryable: false;
	status: number;
}

export interface PropsServerError {
	variant: "server-error";
	retryable: true;
	status: number;
	autoload: boolean;
}

export interface PropsError {
	variant: "error";
	retryable: boolean; // true for network, false for abort
	message: string;
}

/** Negative cache entry for `failedProps` (Change 4). */
export interface FailedPropsEntry {
	/** The classification variant that caused the failure. */
	variant: PropsResult["variant"];
	/** If true, give up entirely (unrecoverable or budget exhausted). */
	giveUp: boolean;
	/** Unix ms timestamp until which re-probing should be suppressed. */
	cooldownUntil: number;
}

// ---------------------------------------------------------------------------

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
