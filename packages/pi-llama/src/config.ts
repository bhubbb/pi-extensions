/**
 * Configuration resolution for pi-llama multi-backend support.
 *
 * Priority chain: env vars → persisted config file → models.json fallback → defaults.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./constants";
import type { LlamaBackendConfig, PersistedConfig, ResolvedBackend } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-llama.json");
export const CONFIG_VERSION = 1;

export const DEFAULT_BASE_URL = "http://localhost:8080/v1";
export const DEFAULT_API_KEY = "no-key";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_PREFIX = "";

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/** Load the persisted JSON config, returning empty object on any error. */
export async function loadPersistedConfig(): Promise<PersistedConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf-8");
		return JSON.parse(raw) as PersistedConfig;
	} catch {
		return {};
	}
}

/** Atomically write the persisted config file. */
export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	const tmpFile = `${CONFIG_PATH}.tmp`;
	await writeFile(tmpFile, JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2));
	await rename(tmpFile, CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// models.json fallback
// ---------------------------------------------------------------------------

/**
 * Read legacy models.json as a fallback for a single llama-cpp backend.
 * Returns a partial backend config if a `llama-cpp` provider is found.
 */
export async function loadModelsJsonFallback(): Promise<Partial<LlamaBackendConfig>> {
	try {
		const path = resolve(homedir(), ".pi", "agent", "models.json");
		if (!existsSync(path)) return {};
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw);
		const llamaCpp = parsed.providers?.["llama-cpp"];
		if (!llamaCpp) return {};
		return {
			baseUrl: llamaCpp.baseUrl,
			apiKey: llamaCpp.apiKey,
			api: llamaCpp.api,
			authHeader: llamaCpp.authHeader,
			contextWindow: llamaCpp.contextWindow,
			maxTokens: llamaCpp.maxTokens,
		};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

export function stripTrailingSlash(s: string): string {
	return s.replace(/\/+$/, "");
}

/** Resolve an API key value, supporting env var interpolation. */
export function resolveSingleKey(input?: string): string {
	if (!input) return DEFAULT_API_KEY;
	if (input.startsWith("!")) return input.slice(1);
	if (input in process.env) return process.env[input] || DEFAULT_API_KEY;
	return input;
}

/**
 * Build an effective backend config for a single backend entry.
 *
 * Provider ID naming:
 *   - Single backend mode (env var, models.json, or defaults): "llama-cpp"
 *     for full backward compatibility — single backend, no collisions.
 *   - Multi-backend mode (settings file backends[]): "llama-cpp-0", "llama-cpp-1", etc.
 *
 * @param singleBackendMode - true when there's only one backend (env var, models.json
 *                            fallback, or defaults). Results in "llama-cpp" provider ID.
 *                            false when the settings file prescribes multiple backends.
 */
export function resolveBackend(
	backend: LlamaBackendConfig,
	idx: number,
	fallback: Partial<LlamaBackendConfig>,
	singleBackendMode: boolean,
): ResolvedBackend {
	// Legacy env var support: LLAMA_BASE_URL / LLAMA_API_KEY only apply to the first
	// backend (idx === 0) for backward compatibility.
	const baseUrl =
		idx === 0
			? stripTrailingSlash(process.env.LLAMA_BASE_URL ?? backend.baseUrl ?? fallback.baseUrl ?? DEFAULT_BASE_URL)
			: stripTrailingSlash(backend.baseUrl ?? fallback.baseUrl ?? DEFAULT_BASE_URL);

	const apiKey =
		idx === 0
			? resolveSingleKey(
					process.env.LLAMA_API_KEY ?? backend.apiKey ?? fallback.apiKey,
			  )
			: resolveSingleKey(backend.apiKey ?? fallback.apiKey);

	// Provider ID: single-backend mode always uses "llama-cpp" for backward compat.
	// Multi-backend mode (settings file) uses numbered IDs to avoid collisions.
	const providerId = singleBackendMode ? "llama-cpp" : `llama-cpp-${idx}`;

	return {
		providerId,
		baseUrl,
		apiKey,
		api: backend.api ?? fallback.api ?? DEFAULT_API,
		authHeader: backend.authHeader ?? fallback.authHeader ?? false,
		prefix: backend.prefix ?? fallback.prefix ?? DEFAULT_PREFIX,
		contextWindow: backend.contextWindow ?? fallback.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: backend.maxTokens ?? fallback.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

/**
 * Resolve the full configuration from all sources.
 *
 * Priority chain:
 *   1. If LLAMA_BASE_URL env var is set → single-backend mode (backward compat)
 *   2. Otherwise → use PersistedConfig.backends[] (multi-backend mode)
 *   3. Fall back to models.json llama-cpp entry (single-backend mode)
 *   4. Fall back to defaults (single-backend mode)
 *
 * Single-backend mode: provider ID is always "llama-cpp" (backward compat).
 * Multi-backend mode (settings file): provider IDs are "llama-cpp-0", etc.
 */
export async function resolveConfig(): Promise<ResolvedBackend[]> {
	const persisted = await loadPersistedConfig();
	const fallback = await loadModelsJsonFallback();

	// Case 1: Legacy env var — single backend, backward compat
	if (process.env.LLAMA_BASE_URL) {
		return [
			resolveBackend(
				{ baseUrl: process.env.LLAMA_BASE_URL, apiKey: process.env.LLAMA_API_KEY },
				0,
				fallback,
				true, // single-backend mode
			),
		];
	}

	// Case 2: Persisted config with backends — multi-backend mode
	if (persisted.backends && persisted.backends.length > 0) {
		return persisted.backends.map((backend, idx) =>
			resolveBackend(backend, idx, fallback, false), // multi-backend mode
		);
	}

	// Case 3: Fall back to models.json llama-cpp entry — single backend
	if (fallback.baseUrl || fallback.apiKey) {
		return [resolveBackend({ baseUrl: DEFAULT_BASE_URL }, 0, fallback, true)];
	}

	// Case 4: Fall back to defaults — single backend
	return [resolveBackend({ baseUrl: DEFAULT_BASE_URL }, 0, {}, true)];
}
