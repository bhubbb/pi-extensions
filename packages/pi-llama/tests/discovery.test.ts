/**
 * Tests for model discovery — verifies automatic context window extraction
 * from mocked /v1/models responses using the actual llama.cpp schema.
 *
 * Schema reference (llama.cpp server.cpp model_meta()):
 *   meta.n_ctx_train = trained context from GGUF (NOT runtime n_ctx)
 *   meta.n_params    = model parameter count
 *   Runtime n_ctx    = only from /props → default_generation_settings.n_ctx
 */
import { describe, expect, it } from "bun:test";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "../src/constants";
import type { PersistedConfig, ResolvedBackend } from "../src/types";

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

/**
 * Build a /v1/models response matching the actual llama.cpp schema.
 */
function buildModelsResponse(options: {
	metaNctxTrain?: number | null;
	statusValue?: string;
	aliases?: string[];
	inputModalities?: string[];
}): Record<string, unknown> {
	const metaNctxTrain = options.metaNctxTrain;

	const meta: Record<string, unknown> = {
		vocab_type: 2,
		n_vocab: 151936,
		n_embd: 3584,
		n_params: 7_621_203_328,
		size: 7_837_845_472,
		n_ctx_train: metaNctxTrain !== undefined ? metaNctxTrain : 32768,
		"general.architecture": "qwen2",
		"general.type": "model",
		"general.name": "Qwen2.5 7B Instruct",
		"general.version": "2.5",
		"general.finetune": "Instruct",
		"general.basename": "Qwen2.5",
		"general.size_label": "7B",
		"general.license": "apache-2.0",
	};
	// When n_ctx_train is explicitly null, omit it (simulates older servers)
	if (metaNctxTrain === null) {
		delete meta.n_ctx_train;
	}

	const modelObj: Record<string, unknown> = {
		id: "unsloth/Qwen2.5-7B-Instruct-Q8_0",
		object: "model",
		created: 1700000000,
		owned_by: "llamacpp",
		meta,
	};
	if (options.aliases) modelObj.aliases = options.aliases;
	if (options.statusValue) modelObj.status = { value: options.statusValue };
	if (options.inputModalities) modelObj.architecture = { input_modalities: options.inputModalities };

	return { object: "list", data: [modelObj] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchModelList", () => {
	it("extracts context window from meta.n_ctx_train (actual llama.cpp schema)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(buildModelsResponse({ metaNctxTrain: 131_072 }));
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(1);
			expect(models[0].contextWindow).toBe(131_072);
			// Pre-discovery maxTokens should be capped at DEFAULT_MAX_TOKENS
			expect(models[0].maxTokens).toBe(DEFAULT_MAX_TOKENS);
		} finally {
			srv.stop();
		}
	});

	it("falls back to DEFAULT_CONTEXT_WINDOW when meta.n_ctx_train is missing", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(buildModelsResponse({ metaNctxTrain: null }));
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(1);
			expect(models[0].contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		} finally {
			srv.stop();
		}
	});

	it("handles multiple models with different n_ctx_train values", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					object: "list",
					data: [
						{
							id: "model-a",
							object: "model",
							created: 1700000000,
							owned_by: "llamacpp",
							meta: { n_ctx_train: 8192, n_params: 1_000_000 },
						},
						{
							id: "model-b",
							object: "model",
							created: 1700000000,
							owned_by: "llamacpp",
							meta: { n_ctx_train: 131_072, n_params: 8_000_000_000 },
						},
						{
							id: "model-c",
							object: "model",
							created: 1700000000,
							owned_by: "llamacpp",
							// No meta at all — should use defaults
						},
					],
				});
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(3);
			expect(models[0].contextWindow).toBe(8192);
			expect(models[1].contextWindow).toBe(131_072);
			expect(models[2].contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		} finally {
			srv.stop();
		}
	});

	it("handles image modality from architecture.input_modalities", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					buildModelsResponse({
						inputModalities: ["text", "image"],
						metaNctxTrain: 32_768,
					}),
				);
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(1);
			expect(models[0].input).toContain("text");
			expect(models[0].input).toContain("image");
			expect(models[0].name).toContain("(image)");
		} finally {
			srv.stop();
		}
	});

	it("marks loaded models with (loaded) suffix", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					buildModelsResponse({
						statusValue: "loaded",
						metaNctxTrain: 32_768,
					}),
				);
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(1);
			expect(models[0].name).toContain("(loaded)");
		} finally {
			srv.stop();
		}
	});

	it("uses aliases[0] as display name when available", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					buildModelsResponse({
						aliases: ["qwen2.5-7b", "qwen-7b"],
						metaNctxTrain: 32_768,
					}),
				);
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(1);
			expect(models[0].name).toBe("qwen2.5-7b");
			expect(models[0].id).toBe("unsloth/Qwen2.5-7B-Instruct-Q8_0");
		} finally {
			srv.stop();
		}
	});

	it("strips prefix from display name", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					buildModelsResponse({
						aliases: ["unsloth/qwen2.5-7b"],
						metaNctxTrain: 32_768,
					}),
				);
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key", "unsloth/");

			expect(models).toHaveLength(1);
			expect(models[0].name).toBe("qwen2.5-7b");
		} finally {
			srv.stop();
		}
	});

	it("returns empty array when /models returns non-200", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Service Unavailable", { status: 503 });
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(0);
		} finally {
			srv.stop();
		}
	});

	it("returns empty array when data array is empty", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({ object: "list", data: [] });
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models).toHaveLength(0);
		} finally {
			srv.stop();
		}
	});

	it("caps maxTokens at DEFAULT_MAX_TOKENS for large n_ctx_train (pre-discovery)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(buildModelsResponse({ metaNctxTrain: 131_072 }));
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models[0].contextWindow).toBe(131_072);
			expect(models[0].maxTokens).toBe(DEFAULT_MAX_TOKENS);
		} finally {
			srv.stop();
		}
	});

	it("maxTokens equals contextWindow when n_ctx_train <= DEFAULT_MAX_TOKENS", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(buildModelsResponse({ metaNctxTrain: 4096 }));
			},
		});

		try {
			const { fetchModelList } = await import("../src/discovery.ts");
			const models = await fetchModelList(`http://localhost:${srv.port}/v1`, "no-key");

			expect(models[0].contextWindow).toBe(4096);
			expect(models[0].maxTokens).toBe(4096);
		} finally {
			srv.stop();
		}
	});
});

describe("fetchModelProps", () => {
	// -----------------------------------------------------------------------
	// Happy-path tests (ok variant)
	// -----------------------------------------------------------------------

	it("extracts runtime n_ctx from /props default_generation_settings", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch(req: Request) {
				if (req.url.includes("/props")) {
					return Response.json({
						default_generation_settings: { n_ctx: 65_536 },
						chat_template: "",
						build_info: "llama.cpp b3000",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
			);

			expect(result.variant).toBe("ok");
			if (result.variant === "ok") {
				expect(result.contextWindow).toBe(65_536);
				expect(result.maxTokens).toBe(65_536); // No cap when /props confirms
			}
		} finally {
			srv.stop();
		}
	});

	it("detects thinking support from enable_thinking in chat_template", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch(req: Request) {
				if (req.url.includes("/props")) {
					return Response.json({
						default_generation_settings: { n_ctx: 131_072 },
						chat_template: "{% if enable_thinking %}thinking{% endif %}\n{{ message }}",
						build_info: "llama.cpp b3500",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"thinking-model",
			);

			expect(result.variant).toBe("ok");
			if (result.variant === "ok") {
				expect(result.supportsThinking).toBe(true);
			}
		} finally {
			srv.stop();
		}
	});

	it("does NOT detect thinking when chat_template lacks enable_thinking", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch(req: Request) {
				if (req.url.includes("/props")) {
					return Response.json({
						default_generation_settings: { n_ctx: 32_768 },
						chat_template: "{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}",
						build_info: "llama.cpp b3000",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"normal-model",
			);

			expect(result.variant).toBe("ok");
			if (result.variant === "ok") {
				expect(result.supportsThinking).toBe(false);
			}
		} finally {
			srv.stop();
		}
	});

	it("falls back to defaults when n_ctx is missing from /props", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch(req: Request) {
				if (req.url.includes("/props")) {
					return Response.json({
						chat_template: "",
						build_info: "llama.cpp b3000",
					});
				}
				return new Response("not found", { status: 404 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
			);

			expect(result.variant).toBe("ok");
			if (result.variant === "ok") {
				expect(result.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
				expect(result.maxTokens).toBe(DEFAULT_MAX_TOKENS);
			}
		} finally {
			srv.stop();
		}
	});

	// -----------------------------------------------------------------------
	// Classification tests (Change 2)
	// -----------------------------------------------------------------------

	it("classifies 'model is not loaded' as not-loaded (retryable)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					{
						error: {
							code: 400,
							message: "model is not loaded",
							type: "invalid_request",
						},
					},
					{ status: 400 },
				);
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
				false, // autoload=false
			);

			expect(result.variant).toBe("not-loaded");
			if (result.variant === "not-loaded") {
				expect(result.retryable).toBe(true);
				expect(result.status).toBe(400);
				expect(result.errorMessage).toBe("model is not loaded");
			}
		} finally {
			srv.stop();
		}
	});

	it("classifies 'model not found' as not-found (retryable)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return Response.json(
					{
						error: {
							code: 400,
							message: "model 'unsloth/gemma-4-31B-it-qat-GGUF:Q4_K_XL' not found",
							type: "invalid_request",
						},
					},
					{ status: 400 },
				);
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"unsloth/gemma-4-31B-it-qat-GGUF:Q4_K_XL",
			);

			expect(result.variant).toBe("not-found");
			if (result.variant === "not-found") {
				expect(result.retryable).toBe(true);
				expect(result.status).toBe(400);
			}
		} finally {
			srv.stop();
		}
	});

	it("classifies 404 with no JSON body as endpoint-missing (non-retryable)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return new Response("", { status: 404 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
			);

			expect(result.variant).toBe("endpoint-missing");
			if (result.variant === "endpoint-missing") {
				expect(result.retryable).toBe(false);
				expect(result.status).toBe(404);
			}
		} finally {
			srv.stop();
		}
	});

	it("classifies 500 during autoload as server-error (silent, retryable)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Internal Server Error", { status: 500 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
				true, // autoload=true
			);

			expect(result.variant).toBe("server-error");
			if (result.variant === "server-error") {
				expect(result.retryable).toBe(true);
				expect(result.autoload).toBe(true);
				expect(result.status).toBe(500);
			}
		} finally {
			srv.stop();
		}
	});

	it("classifies 503 as server-error (retryable)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Service Unavailable", { status: 503 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
			);

			expect(result.variant).toBe("server-error");
			if (result.variant === "server-error") {
				expect(result.retryable).toBe(true);
				expect(result.status).toBe(503);
			}
		} finally {
			srv.stop();
		}
	});

	it("handles malformed JSON body gracefully (falls back to error variant)", async () => {
		const srv = Bun.serve({
			port: 0,
			fetch() {
				return new Response("not json", { status: 400 });
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			const result = await fetchModelProps(
				`http://localhost:${srv.port}/v1`,
				"test-model",
			);

			expect(result.variant).toBe("error");
			if (result.variant === "error") {
				expect(result.retryable).toBe(true); // bare 400 is treated as transient
			}
		} finally {
			srv.stop();
		}
	});

	// -----------------------------------------------------------------------
	// URL construction
	// -----------------------------------------------------------------------

	it("strips /v1 suffix from baseUrl when building /props URL", async () => {
		let capturedPath = "";
		const srv = Bun.serve({
			port: 0,
			fetch(req: Request) {
				capturedPath = new URL(req.url).pathname;
				return Response.json({
					default_generation_settings: { n_ctx: 8192 },
					chat_template: "",
				});
			},
		});

		try {
			const { fetchModelProps } = await import("../src/discovery.ts");
			await fetchModelProps(`http://localhost:${srv.port}/v1`, "test-model");

			// Should hit /props (not /v1/props)
			expect(capturedPath).toBe("/props");
		} finally {
			srv.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Backoff helper tests
// ---------------------------------------------------------------------------

describe("delayForAttempt", () => {
	it("returns delays within bounds (full jitter)", () => {
		const { delayForAttempt } = require("../src/constants.ts");
		const baseMs = 500;
		const capMs = 30_000;

		for (let attempt = 0; attempt < 10; attempt++) {
			const delay = delayForAttempt(attempt, baseMs, capMs);
			expect(delay).toBeGreaterThanOrEqual(0);
			const maxExpected = Math.min(baseMs * (1 << attempt), capMs);
			expect(delay).toBeLessThan(maxExpected);
		}
	});

	it("caps delay at capMs", () => {
		const { delayForAttempt } = require("../src/constants.ts");
		const capMs = 1000;

		for (let attempt = 0; attempt < 20; attempt++) {
			const delay = delayForAttempt(attempt, 500, capMs);
			expect(delay).toBeLessThan(capMs);
		}
	});
});

describe("provider registration with thinking models", () => {
	it("buildThinkingLevelMap returns all five levels", async () => {
		const { buildThinkingLevelMap } = await import("../src/provider.ts");
		const map = buildThinkingLevelMap();

		expect("minimal" in map).toBe(true);
		expect("low" in map).toBe(true);
		expect("medium" in map).toBe(true);
		expect("high" in map).toBe(true);
		expect("xhigh" in map).toBe(true);
		expect(Object.keys(map).length).toBe(5);
	});

	it("buildModelCompat adds thinkingFormat for reasoning models", async () => {
		const { buildModelCompat } = await import("../src/provider.ts");

		const thinkingCompat = buildModelCompat({
			id: "thinking-model",
			name: "Thinking Model",
			reasoning: true,
			input: ["text"],
			contextWindow: 131_072,
			maxTokens: 131_072,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(thinkingCompat.thinkingFormat).toBe("qwen-chat-template");

		const normalCompat = buildModelCompat({
			id: "normal-model",
			name: "Normal Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(Object.keys(normalCompat).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// serverCacheKey normalization tests
// ---------------------------------------------------------------------------

describe("serverCacheKey", () => {
	it("normalizes trailing /v1", async () => {
		const { serverCacheKey } = await import("../src/config.ts");
		const withV1 = serverCacheKey("http://10.8.0.3:8080/v1", "model-a");
		const withoutV1 = serverCacheKey("http://10.8.0.3:8080", "model-a");
		expect(withV1).toBe(withoutV1);
	});

	it("normalizes trailing slash", async () => {
		const { serverCacheKey } = await import("../src/config.ts");
		const withSlash = serverCacheKey("http://10.8.0.3:8080/", "model-a");
		const withoutSlash = serverCacheKey("http://10.8.0.3:8080", "model-a");
		expect(withSlash).toBe(withoutSlash);
	});

	it("distinguishes different baseUrls for the same model", async () => {
		const { serverCacheKey } = await import("../src/config.ts");
		const key1 = serverCacheKey("http://10.8.0.3:8080/v1", "model-a");
		const key2 = serverCacheKey("http://10.8.0.4:8080/v1", "model-a");
		expect(key1).not.toBe(key2);
	});

	it("preserves model ids with colons (quant suffixes)", async () => {
		const { serverCacheKey, parseServerCacheKey } = await import("../src/config.ts");
		const modelId = "unsloth/Qwen:Q6_K";
		const key = serverCacheKey("http://10.8.0.3:8080/v1", modelId);
		const parsed = parseServerCacheKey(key);
		expect(parsed.baseUrl).toBe("http://10.8.0.3:8080");
		expect(parsed.modelId).toBe(modelId);
	});

	it("round-trips parseServerCacheKey for simple model ids", async () => {
		const { serverCacheKey, parseServerCacheKey } = await import("../src/config.ts");
		const baseUrl = "http://localhost:8080/v1";
		const modelId = "test-model";
		const key = serverCacheKey(baseUrl, modelId);
		const parsed = parseServerCacheKey(key);
		expect(parsed.baseUrl).toBe("http://localhost:8080");
		expect(parsed.modelId).toBe(modelId);
	});
});

// ---------------------------------------------------------------------------
// Stale entry pruning
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
	it("drops entries whose baseUrl no longer matches any current backend", async () => {
		const { pruneStaleEntries } = await import("../src/config.ts");
		const persisted: PersistedConfig = {
			backends: [
				{ baseUrl: "http://10.8.0.3:8080/v1" },
				{ baseUrl: "http://10.8.0.4:8080/v1" },
			],
			discoveredProps: {
				"http://10.8.0.3:8080:model-a": {
					key: "http://10.8.0.3:8080:model-a",
					contextWindow: 8192,
					maxTokens: 8192,
					supportsThinking: false,
					discoveredAt: 1,
				},
				"http://10.8.0.5:9090:old-model": {
					key: "http://10.8.0.5:9090:old-model",
					contextWindow: 4096,
					maxTokens: 4096,
					supportsThinking: false,
					discoveredAt: 2,
				},
			},
		};

		// Only backends 3 and 4 are current — backend 5 was removed
		const currentBackends: ResolvedBackend[] = [
			{ providerId: "llama-cpp-0", baseUrl: "http://10.8.0.3:8080/v1", apiKey: "", api: "", authHeader: false, prefix: "", contextWindow: 8192, maxTokens: 16384 },
			{ providerId: "llama-cpp-1", baseUrl: "http://10.8.0.4:8080/v1", apiKey: "", api: "", authHeader: false, prefix: "", contextWindow: 8192, maxTokens: 16384 },
		];

		const result = pruneStaleEntries(persisted, currentBackends);
		expect(Object.keys(result.discoveredProps ?? {}).length).toBe(1);
		expect("http://10.8.0.3:8080:model-a" in (result.discoveredProps ?? {})).toBe(true);
		expect("http://10.8.0.5:9090:old-model" in (result.discoveredProps ?? {})).toBe(false);
	});

	it("keeps all entries when all backends are still present", async () => {
		const { pruneStaleEntries } = await import("../src/config.ts");
		const persisted: PersistedConfig = {
			discoveredProps: {
				"http://10.8.0.3:8080:model-a": {
					key: "http://10.8.0.3:8080:model-a",
					contextWindow: 8192,
					maxTokens: 8192,
					supportsThinking: false,
					discoveredAt: 1,
				},
				"http://10.8.0.4:8080:model-b": {
					key: "http://10.8.0.4:8080:model-b",
					contextWindow: 131_072,
					maxTokens: 131_072,
					supportsThinking: true,
					discoveredAt: 2,
				},
			},
		};

		const currentBackends: ResolvedBackend[] = [
			{ providerId: "llama-cpp-0", baseUrl: "http://10.8.0.3:8080/v1", apiKey: "", api: "", authHeader: false, prefix: "", contextWindow: 8192, maxTokens: 16384 },
			{ providerId: "llama-cpp-1", baseUrl: "http://10.8.0.4:8080/v1", apiKey: "", api: "", authHeader: false, prefix: "", contextWindow: 8192, maxTokens: 16384 },
		];

		const result = pruneStaleEntries(persisted, currentBackends);
		expect(Object.keys(result.discoveredProps ?? {}).length).toBe(2);
	});
});
