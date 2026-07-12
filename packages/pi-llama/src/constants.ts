/**
 * Shared constants for pi-llama multi-backend support.
 */

// Fallback for /v1/models entries missing meta.n_ctx.
// 32768 covers most modern models (Qwen3, Llama 3, Mistral, Gemma). The real
// value comes from /props (server n_ctx) or meta.n_ctx_train (GGUF cap).
export const DEFAULT_CONTEXT_WINDOW = 32768;

// llama.cpp has no output-token cap, so use Pi's own default.
// 32768 matches the context fallback; per-request max_tokens is still bounded
// by the server's actual n_ctx.
export const DEFAULT_MAX_TOKENS = 32768;

// Timeout for /props discovery (ms) — kept as legacy alias / overall ceiling.
export const PROPS_TIMEOUT_MS = 120_000;

// Per-attempt abort timeout. Each fetchModelProps call uses this so a stuck
// request doesn't burn the whole retry budget (Change 8).
export const PROPS_ATTEMPT_TIMEOUT_MS = 15_000;

// Per-variant max retry attempts (Change 8).
export const PROPS_NOT_LOADED_MAX_ATTEMPTS = 3;
export const PROPS_NOT_FOUND_MAX_ATTEMPTS = 2;
export const PROPS_SERVER_ERROR_MAX_ATTEMPTS = 3;
export const PROPS_AUTOLOAD_MAX_ATTEMPTS = 5;

// Cooldown durations (ms) for the negative-result cache (Change 8).
// These define the minimum gap between retry rounds for the same model.
// Doubled on the before_provider_request probe path.
export const PROPS_COOLDOWN_NOT_LOADED_MS = 5_000;
export const PROPS_COOLDOWN_SERVER_ERROR_MS = 30_000;
export const PROPS_COOLDOWN_NETWORK_ERROR_MS = 10_000;

// Base delay (ms) for per-variant backoff. Actual delay uses full jitter.
export const PROPS_BACKOFF_NOT_LOADED_BASE_MS = 500;
export const PROPS_BACKOFF_NOT_FOUND_BASE_MS = 500;
export const PROPS_BACKOFF_SERVER_ERROR_BASE_MS = 1_000;
export const PROPS_BACKOFF_AUTOLOAD_BASE_MS = 1_000;

/**
 * Pure backoff helper with full jitter (AWS-style).
 * Returns a delay in ms for the given 0-based attempt number.
 * Full jitter: `random(0, min(base * 2^attempt, cap))` — keeps expected
 * delay at `base/2` regardless of attempt count while bounding the max.
 */
export function delayForAttempt(
	attempt: number,
	baseMs: number,
	capMs = 30_000,
): number {
	const exp = Math.min(baseMs * (1 << attempt), capMs);
	return Math.random() * exp;
}

