/**
 * Model discovery for a single llama.cpp backend.
 */
import { Type } from "typebox";
import { Compile } from "typebox/compile";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PROPS_TIMEOUT_MS } from "./constants";
import type { DiscoveredModel, ResolvedBackend } from "./types";

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
				meta: Type.Optional(
					Type.Object({
						n_ctx: Type.Optional(Type.Number()),
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
		meta?: { n_ctx?: number; n_params?: number };
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
		const contextWindow = model.meta?.n_ctx ?? DEFAULT_CONTEXT_WINDOW;
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
			maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {},
			status: model.status,
		} as DiscoveredModel;
	});
}

/**
 * Fetch /props for a model to discover n_ctx, chat_template (thinking support), etc.
 * Returns the updated model with discovered metadata, or undefined on failure.
 */
export async function fetchModelProps(
	baseUrl: string,
	modelId: string,
	autoload = true,
	timeoutMs = PROPS_TIMEOUT_MS,
): Promise<{ contextWindow: number; maxTokens: number; supportsThinking: boolean } | undefined> {

	const propsUrl = `${baseUrl.replace(/\/v1$/, "")}/props?model=${encodeURIComponent(modelId)}&autoload=${autoload}`;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(propsUrl, { signal: controller.signal });
		if (!response.ok) {
			// 500 during autoload is expected when server cancels a load to start another
			if (!(autoload && response.status === 500)) {
				console.warn(`[llama-cpp] /props for ${modelId} returned ${response.status}`);
			}
			return undefined;
		}

		const dataRaw = await response.json();
		if (!validatePropsResponse.Check(dataRaw)) {
			const errors = [...validatePropsResponse.Errors(dataRaw)]
				.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
				.join("; ");
			console.warn(`[llama-cpp] invalid /props response for ${modelId}: ${errors}`);
			return undefined;
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
			contextWindow: typeof nCtx === "number" && nCtx > 0 ? nCtx : DEFAULT_CONTEXT_WINDOW,
			maxTokens: typeof nCtx === "number" && nCtx > 0 ? Math.min(DEFAULT_MAX_TOKENS, nCtx) : DEFAULT_MAX_TOKENS,
			supportsThinking,
		};
	} catch (err) {
		const msg = (err as Error).message;
		if ((err as Error).name !== "AbortError" && !msg.includes("stale after session replacement")) {
			console.warn(`[llama-cpp] /props for ${modelId} failed: ${msg}`);
		}
		return undefined;
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
