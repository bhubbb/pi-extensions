/**
 * Tests for config resolution chain.
 *
 * IMPORTANT: All tests use a temp directory for config files so they never
 * touch the user's real `~/.pi/agent/pi-llama.json` or `~/.pi/agent/models.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "../src/constants";
import {
	CONFIG_VERSION,
	DEFAULT_API_KEY,
	DEFAULT_API,
	DEFAULT_BASE_URL,
	DEFAULT_PREFIX,
	loadModelsJsonFallback,
	loadPersistedConfig,
	resolveBackend,
	resolveConfig,
	savePersistedConfig,
} from "../src/config";

// ---------------------------------------------------------------------------
// Temp-directory fixture
// ---------------------------------------------------------------------------

let TEST_DIR: string;
let TEST_CONFIG_PATH: string;
let TEST_MODELS_JSON_PATH: string;

beforeEach(async () => {
	TEST_DIR = await mkdtemp(join(tmpdir(), "pi-llama-test-"));
	TEST_CONFIG_PATH = join(TEST_DIR, "pi-llama.json");
	TEST_MODELS_JSON_PATH = join(TEST_DIR, "models.json");
	// Clean up env vars before each test
	delete process.env.LLAMA_BASE_URL;
	delete process.env.LLAMA_API_KEY;
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
	// Clean up env vars after each test
	delete process.env.LLAMA_BASE_URL;
	delete process.env.LLAMA_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config resolution", () => {
	describe("resolveBackend", () => {
		it("should use backend.baseUrl when no env vars or fallback", () => {
			const result = resolveBackend({ baseUrl: "http://custom:8080/v1" }, 0, {}, true);
			expect(result.baseUrl).toBe("http://custom:8080/v1");
		});

		it("should apply trailing slash stripping", () => {
			const result = resolveBackend({ baseUrl: "http://localhost:8080/v1/" }, 0, {}, true);
			expect(result.baseUrl).toBe("http://localhost:8080/v1");
		});

		it("should use fallback.baseUrl when backend has none", () => {
			const result = resolveBackend({}, 0, { baseUrl: "http://fallback:8080/v1" }, true);
			expect(result.baseUrl).toBe("http://fallback:8080/v1");
		});

		it("should use defaults when nothing else is available", () => {
			const result = resolveBackend({}, 0, {}, true);
			expect(result.baseUrl).toBe(DEFAULT_BASE_URL);
			expect(result.apiKey).toBe(DEFAULT_API_KEY);
			expect(result.api).toBe(DEFAULT_API);
			expect(result.prefix).toBe(DEFAULT_PREFIX);
			expect(result.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
			expect(result.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		});

		it("should use backend.contextWindow and maxTokens when provided", () => {
			const result = resolveBackend(
				{ baseUrl: "http://custom:8080/v1", contextWindow: 131_072, maxTokens: 65_536 },
				0,
				{},
				true,
			);
			expect(result.contextWindow).toBe(131_072);
			expect(result.maxTokens).toBe(65_536);
		});

		it("should use fallback contextWindow and maxTokens when backend has none", () => {
			const result = resolveBackend(
				{ baseUrl: "http://custom:8080/v1" },
				0,
				{ contextWindow: 131_072, maxTokens: 32_768 },
				true,
			);
			expect(result.contextWindow).toBe(131_072);
			expect(result.maxTokens).toBe(32_768);
		});

		it("should resolve apiKey from env var", () => {
			process.env.TEST_API_KEY = "secret-key-123";
			const result = resolveBackend({ apiKey: "TEST_API_KEY" }, 0, {}, true);
			expect(result.apiKey).toBe("secret-key-123");
			delete process.env.TEST_API_KEY;
		});

		it("should resolve apiKey literal with ! prefix", () => {
			const result = resolveBackend({ apiKey: "!literal-key" }, 0, {}, true);
			expect(result.apiKey).toBe("literal-key");
		});

		// Provider ID: single-backend mode → "llama-cpp"
		it("should use 'llama-cpp' in single-backend mode (defaults)", () => {
			const result = resolveBackend({ baseUrl: DEFAULT_BASE_URL }, 0, {}, true);
			expect(result.providerId).toBe("llama-cpp");
		});

		it("should use 'llama-cpp' in single-backend mode (env var)", () => {
			process.env.LLAMA_BASE_URL = "http://env:8080/v1";
			const result = resolveBackend({ baseUrl: "http://env:8080/v1" }, 0, {}, true);
			expect(result.providerId).toBe("llama-cpp");
			delete process.env.LLAMA_BASE_URL;
		});

		it("should use 'llama-cpp' in single-backend mode (models.json fallback)", () => {
			const result = resolveBackend(
				{ baseUrl: DEFAULT_BASE_URL },
				0,
				{ baseUrl: "http://fallback:8080/v1" },
				true,
			);
			expect(result.providerId).toBe("llama-cpp");
		});

		// Provider ID: multi-backend mode → numbered
		it("should use 'llama-cpp-0' in multi-backend mode", () => {
			const result = resolveBackend({ baseUrl: "http://local:8080/v1" }, 0, {}, false);
			expect(result.providerId).toBe("llama-cpp-0");
		});

		it("should use 'llama-cpp-1' for second backend in multi-backend mode", () => {
			const result = resolveBackend({ baseUrl: "http://remote:8080/v1" }, 1, {}, false);
			expect(result.providerId).toBe("llama-cpp-1");
		});

		it("should use correct index for third backend", () => {
			const result = resolveBackend({ baseUrl: "http://test:8080/v1" }, 2, {}, false);
			expect(result.providerId).toBe("llama-cpp-2");
		});
	});

	describe("loadPersistedConfig", () => {
		it("should return empty object when file does not exist", async () => {
			const result = await loadPersistedConfig(TEST_CONFIG_PATH);
			expect(result).toEqual({});
		});

		it("should parse valid config file", async () => {
			const config = { version: 1, backends: [{ baseUrl: "http://test:8080/v1" }] };
			await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
			const result = await loadPersistedConfig(TEST_CONFIG_PATH);
			expect(result.version).toBe(1);
			expect(result.backends).toHaveLength(1);
		});
	});

	describe("savePersistedConfig", () => {
		it("should write config file", async () => {
			const config = { version: 1, backends: [{ baseUrl: "http://test:8080/v1", apiKey: "key1" }] };
			await savePersistedConfig(config, TEST_CONFIG_PATH);
			const result = await loadPersistedConfig(TEST_CONFIG_PATH);
			expect(result.version).toBe(CONFIG_VERSION);
			expect(result.backends).toHaveLength(1);
		});

		it("should create parent directory if missing", async () => {
			const nestedPath = join(TEST_DIR, "nested", "subdir", "pi-llama.json");
			await savePersistedConfig({ version: 1 }, nestedPath);
			const result = await loadPersistedConfig(nestedPath);
			expect(result.version).toBe(CONFIG_VERSION);
		});

		it("should write atomically (no .tmp left behind on success)", async () => {
			await savePersistedConfig({ version: 1 }, TEST_CONFIG_PATH);
			expect(existsSync(`${TEST_CONFIG_PATH}.tmp`)).toBe(false);
		});
	});

	describe("loadModelsJsonFallback", () => {
		it("should return empty object when file does not exist", async () => {
			const result = await loadModelsJsonFallback(TEST_MODELS_JSON_PATH);
			expect(result).toEqual({});
		});

		it("should parse valid models.json with llama-cpp provider", async () => {
			const modelsJson = {
				providers: {
					"llama-cpp": {
						baseUrl: "http://models-json:8080/v1",
						apiKey: "json-key",
					},
				},
			};
			await writeFile(TEST_MODELS_JSON_PATH, JSON.stringify(modelsJson));
			const result = await loadModelsJsonFallback(TEST_MODELS_JSON_PATH);
			expect(result.baseUrl).toBe("http://models-json:8080/v1");
			expect(result.apiKey).toBe("json-key");
		});

		it("should return empty object when llama-cpp provider is missing", async () => {
			const modelsJson = { providers: { other: { baseUrl: "http://other:8080/v1" } } };
			await writeFile(TEST_MODELS_JSON_PATH, JSON.stringify(modelsJson));
			const result = await loadModelsJsonFallback(TEST_MODELS_JSON_PATH);
			expect(result).toEqual({});
		});
	});

	describe("resolveConfig", () => {
		it("should use LLAMA_BASE_URL env var in single-backend mode with 'llama-cpp'", async () => {
			process.env.LLAMA_BASE_URL = "http://env-server:8080/v1";
			const result = await resolveConfig(TEST_CONFIG_PATH, TEST_MODELS_JSON_PATH);
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe("http://env-server:8080/v1");
			expect(result[0].providerId).toBe("llama-cpp");
		});

		it("should use persisted backends with numbered IDs", async () => {
			const config = {
				version: 1,
				backends: [
					{ baseUrl: "http://local:8080/v1", apiKey: "local-key" },
					{ baseUrl: "http://remote:8080/v1", apiKey: "remote-key" },
				],
			};
			await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
			const result = await resolveConfig(TEST_CONFIG_PATH, TEST_MODELS_JSON_PATH);
			expect(result).toHaveLength(2);
			expect(result[0].baseUrl).toBe("http://local:8080/v1");
			expect(result[0].providerId).toBe("llama-cpp-0");
			expect(result[1].baseUrl).toBe("http://remote:8080/v1");
			expect(result[1].providerId).toBe("llama-cpp-1");
		});

		it("should fall back to models.json with 'llama-cpp'", async () => {
			const modelsJson = {
				providers: {
					"llama-cpp": {
						baseUrl: "http://models-json:8080/v1",
						apiKey: "json-key",
					},
				},
			};
			await writeFile(TEST_MODELS_JSON_PATH, JSON.stringify(modelsJson));
			const result = await resolveConfig(TEST_CONFIG_PATH, TEST_MODELS_JSON_PATH);
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe("http://models-json:8080/v1");
			expect(result[0].providerId).toBe("llama-cpp");
		});

		it("should fall back to defaults with 'llama-cpp'", async () => {
			const result = await resolveConfig(TEST_CONFIG_PATH, TEST_MODELS_JSON_PATH);
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe(DEFAULT_BASE_URL);
			expect(result[0].providerId).toBe("llama-cpp");
		});

		it("should prefer env var over persisted config", async () => {
			const config = {
				version: 1,
				backends: [{ baseUrl: "http://persisted:8080/v1" }],
			};
			await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
			process.env.LLAMA_BASE_URL = "http://env-overrides:8080/v1";
			const result = await resolveConfig(TEST_CONFIG_PATH, TEST_MODELS_JSON_PATH);
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe("http://env-overrides:8080/v1");
			expect(result[0].providerId).toBe("llama-cpp");
		});
	});
});
