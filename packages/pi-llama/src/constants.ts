/**
 * Shared constants for pi-llama multi-backend support.
 */

// Fallback for /v1/models entries missing meta.n_ctx.
export const DEFAULT_CONTEXT_WINDOW = 8192;

// llama.cpp has no output-token cap, so use Pi's own default.
export const DEFAULT_MAX_TOKENS = 16384;

// Timeout for /props discovery (ms).
export const PROPS_TIMEOUT_MS = 120_000;
