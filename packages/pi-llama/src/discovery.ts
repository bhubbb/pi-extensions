/**
 * Model discovery for a single llama.cpp backend.
 */
import { Type } from "typebox";
import { Compile } from "typebox/compile";

import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	PROPS_ATTEMPT_TIMEOUT_MS,
} from "./constants";
import type { DiscoveredModel, PropsResult, ResolvedBackend } from "./types";

// ---------------------------------------------------------------------------
// SSE event types for model loading progress
// ---------------------------------------------------------------------------

export type ApiModelLoadStage = "text_model" | "spec_model" | "mmproj_model";

export const MODEL_LOAD_STAGE_LABELS: Record<ApiModelLoadStage, string> = {
	text_model: "Loading weights",
	spec_model: "Loading draft",
	mmproj_model: "Loading projector",
};

export type ApiModelsSseProgress = {
	stages: ApiModelLoadStage[];
	current: ApiModelLoadStage;
	value: number;
};

export type ApiModelsSseData = {
	status: string;
	progress?: ApiModelsSseProgress;
	exit_code?: number;
};

export type ApiModelsSseEvent = {
	model: string;
	event: string;
	data: ApiModelsSseData;
};

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const ModelsResponseSchema = Type.Object({
	data: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				aliases: Type.Optional(Type.Array(Type.String())),
				status: Type.Optional(
					Type.Object({
						value: Type.Optional(
							Type.Union([
								Type.Literal("unloaded"),
								Type.Literal("loading"),
								Type.Literal("loaded"),
								Type.Literal("sleeping"),
								Type.Literal("unknown"),
							]),
						),
					}),
				),
				architecture: Type.Optional(
					Type.Object({
						input_modalities: Type.Optional(Type.Array(Type.String())),
					}),
				),
				// meta comes from GGUF model metadata (model_meta() in llama.cpp server).
				// Contains n_ctx_train (trained context), NOT n_ctx (runtime context).
				// The authoritative runtime n_ctx is only available from /props.
				// We use n_ctx_train as the best pre-discovery estimate.
				meta: Type.Optional(
					Type.Object({
						n_ctx_train: Type.Optional(Type.Number()),
						n_params: Type.Optional(Type.Number()),
					}),
				),
			}),
		),
	),
});

const validateModelsResponse = Compile(ModelsResponseSchema);

const PropsResponseSchema = Type.Object({
	default_generation_settings: Type.Optional(
		Type.Object({
			n_ctx: Type.Optional(Type.Number()),
		}),
	),
	chat_template: Type.Optional(Type.String()),
	build_info: Type.Optional(Type.String()),
});

const validatePropsResponse = Compile(PropsResponseSchema);

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Fetch the list of models from a llama.cpp server and convert to pi models.
 */
export async function fetchModelList(
	baseUrl: string,
	apiKey: string,
	prefix?: string,
): Promise<DiscoveredModel[]> {
	const response = await fetch(`${baseUrl}/models`);
	if (!response.ok) {
		console.warn(`[llama-cpp] ${baseUrl}/models returned ${response.status}`);
		return [];
	}

	const payload: unknown = await response.json();
	if (!validateModelsResponse.Check(payload)) {
		const errors = [...validateModelsResponse.Errors(payload)]
			.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
			.join("; ");
		console.warn(`[llama-cpp] invalid /models response from ${baseUrl}: ${errors}`);
		return [];
	}

	type RawModel = {
		id: string;
		aliases?: string[];
		status?: { value?: string };
		architecture?: { input_modalities?: string[] };
		// meta from GGUF: n_ctx_train (trained context), not runtime n_ctx
		meta?: { n_ctx_train?: number; n_params?: number };
	};
	const data = (payload as { data?: RawModel[] }).data ?? [];
	if (data.length === 0) {
		console.warn(`[llama-cpp] no models returned from ${baseUrl}`);
		return [];
	}

	return data.map((model) => {
		const modalities = model.architecture?.input_modalities ?? ["text"];
		const input = modalities.filter((m): m is "text" | "image" => m === "text" || m === "image");
		const suffixes: string[] = [];
		if (input.includes("image")) {
			suffixes.push("(image)");
		}
		if (model.status?.value === "loaded") {
			suffixes.push("(loaded)");
		}
		// meta.n_ctx_train is the model's trained context (from GGUF metadata), not
		// the configured runtime n_ctx. The authoritative value comes from /props,
		// but n_ctx_train is a much better pre-discovery estimate than 8192.
		const contextWindow = model.meta?.n_ctx_train ?? DEFAULT_CONTEXT_WINDOW;
		const displayName = model.aliases?.[0] || model.id;
		const name = prefix
			? displayName.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "")
			: displayName;
		return {
			id: model.id,
			name: suffixes.length > 0 ? `${name} ${suffixes.join(" ")}` : name,
			reasoning: false, // discovered later via /props
			input,
			contextWindow,
			maxTokens: contextWindow > DEFAULT_MAX_TOKENS ? DEFAULT_MAX_TOKENS : contextWindow,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {},
			status: model.status,
		} as DiscoveredModel;
	});
}

/**
 * Parse a llama.cpp JSON error envelope. Returns `{ message, type }` or null.
 * Guarded by try/catch — the body may be empty or non-JSON on proxies.
 */
function parseLlamaCppError(body: unknown): { message: string; type: string } | null {
	if (typeof body !== "object" || body === null) return null;
	const obj = body as Record<string, unknown>;
	const error = obj.error;
	if (typeof error !== "object" || error === null) return null;
	const errObj = error as Record<string, unknown>;
	const message = typeof errObj.message === "string" ? errObj.message : null;
	const type = typeof errObj.type === "string" ? errObj.type : null;
	if (!message) return null;
	return { message, type: type ?? "" };
}

/**
 * Classify a non-OK /props response into a typed PropsResult variant.
 * Reads the response body first to extract the error message, then
 * classifies based on status + message content.
 */
async function classifyPropsError(
	response: Response,
	autoload: boolean,
): Promise<PropsResult> {
	// Try to parse the error body (guarded — may be empty/non-JSON)
	let parsedError: { message: string; type: string } | null = null;
	try {
		const body = await response.json();
		parsedError = parseLlamaCppError(body);
	} catch {
		// Body was not JSON or empty (proxy, old server, etc.)
	}

	const status = response.status;

	// 404 with no parseable llama.cpp error → endpoint genuinely missing
	if (status === 404 && !parsedError) {
		return { variant: "endpoint-missing", retryable: false, status };
	}

	// Classify by error message (llama.cpp standard envelope)
	if (parsedError) {
		const msg = parsedError.message.toLowerCase();

		// "model is not loaded" — benign probe against a not-yet-loaded model
		if (msg.includes("not loaded") || msg.includes("is not loaded")) {
			return { variant: "not-loaded", retryable: true, status, errorMessage: parsedError.message };
		}

		// "model '<id>' not found" — the id isn't in the server's map
		if (msg.includes("not found") || msg.includes("is not found")) {
			return { variant: "not-found", retryable: true, status, errorMessage: parsedError.message };
		}
	}

	// 5xx errors are transient server errors
	if (status >= 500 && status < 600) {
		return { variant: "server-error", retryable: true, status, autoload };
	}

	// Fallback: bare 400 or other unexpected status
	// Treated as transient (retryable) since /props *should* exist
	return {
		variant: "error",
		retryable: true,
		message: parsedError?.message ?? `unexpected status ${status}`,
	};
}

/**
 * Fetch /props for a model to discover n_ctx, chat_template (thinking support), etc.
 * Returns a typed PropsResult so the caller can react per-case.
 * Uses PROPS_ATTEMPT_TIMEOUT_MS per call (not the legacy PROPS_TIMEOUT_MS).
 */
export async function fetchModelProps(
	baseUrl: string,
	modelId: string,
	autoload = true,
	timeoutMs = PROPS_ATTEMPT_TIMEOUT_MS,
): Promise<PropsResult> {
	const propsUrl = `${baseUrl.replace(/\/v1$/, "")}/props?model=${encodeURIComponent(modelId)}&autoload=${autoload}`;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(propsUrl, { signal: controller.signal });

		if (!response.ok) {
			// 500 during autoload is expected (server cancels a load to start another).
			// Silently classify — the caller's retry loop will handle it.
			const result = await classifyPropsError(response, autoload);
			// Suppress logging for not-loaded (benign — caller skips unloaded models
			// when autoload=false) and 500-during-autoload (expected race). Log
			// everything else at debug level.
			const suppressLog =
				result.variant === "not-loaded" || (autoload && response.status === 500);
			if (!suppressLog) {
				console.debug(
					`[llama-cpp] /props for ${modelId} returned ${response.status} (${result.variant})`,
				);
			}
			return result;
		}

		const dataRaw = await response.json();
		if (!validatePropsResponse.Check(dataRaw)) {
			const errors = [...validatePropsResponse.Errors(dataRaw)]
				.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
				.join("; ");
			console.warn(`[llama-cpp] invalid /props response for ${modelId}: ${errors}`);
			return {
				variant: "error",
				retryable: false,
				message: `invalid response: ${errors}`,
			};
		}
		const data = dataRaw as {
			default_generation_settings?: { n_ctx?: number };
			chat_template?: string;
			build_info?: string;
		};

		const nCtx = data.default_generation_settings?.n_ctx;
		const chatTemplate = data.chat_template;

		// Detect thinking support from chat template
		const supportsThinking = typeof chatTemplate === "string" && chatTemplate.includes("enable_thinking");

		return {
			variant: "ok" as const,
			retryable: false as const,
			contextWindow: typeof nCtx === "number" && nCtx > 0 ? nCtx : DEFAULT_CONTEXT_WINDOW,
			// No output cap once we know the real n_ctx: llama.cpp has no real
			// output-token limit, so let the model use its full context budget for
			// generation (critical for thinking models where reasoning counts toward
			// output). The 16384 DEFAULT_MAX_TOKENS stays as the pre-discovery fallback.
			maxTokens: typeof nCtx === "number" && nCtx > 0 ? nCtx : DEFAULT_MAX_TOKENS,
			supportsThinking,
		};
	} catch (err) {
		const msg = (err as Error).message;
		const isAbort = (err as Error).name === "AbortError";
		const isStale = msg.includes("stale after session replacement");

		if (!isAbort && !isStale) {
			console.warn(`[llama-cpp] /props for ${modelId} failed: ${msg}`);
		}

		// Network errors are retryable; abort/stale are not
		return {
			variant: "error" as const,
			retryable: !isAbort && !isStale,
			message: msg,
		};
	}
}

/**
 * Build the SSE URL for model loading progress events.
 */
export function getSseUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/v1$/, "")}/models/sse`;
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/** Parse SSE data lines from an SSE event string. */
export function parseSseDataLines(event: string): string | null {
	const dataLines = event
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n");
	return dataLines || null;
}

/** Parse SSE events from a raw buffer. Returns individual event strings. */
export function splitSseEvents(buffer: string): { events: string[]; leftover: string } {
	const parts = buffer.split("\n\n");
	const events = parts.slice(0, -1);
	const leftover = parts[parts.length - 1] || "";
	return { events, leftover };
}
