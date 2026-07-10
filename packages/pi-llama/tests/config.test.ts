/**
 * Tests for config resolution chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_PATH,
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
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(homedir(), ".pi", "agent", "test-pi-llama");

function setupTestDir(): void {
	mkdirSync(TEST_DIR, { recursive: true });
}

function teardownTestDir(): void {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config resolution", () => {
	beforeEach(() => {
		setupTestDir();
		// Clean up any env vars before each test
		delete process.env.LLAMA_BASE_URL;
		delete process.env.LLAMA_API_KEY;
	});

	afterEach(() => {
		teardownTestDir();
		// Clean up env vars after each test
		delete process.env.LLAMA_BASE_URL;
		delete process.env.LLAMA_API_KEY;
	});

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
			const result = await loadPersistedConfig();
			expect(result).toEqual({});
		});

		it("should parse valid config file", async () => {
			const config = { version: 1, backends: [{ baseUrl: "http://test:8080/v1" }] };
			mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(config));
			try {
				const result = await loadPersistedConfig();
				expect(result.version).toBe(1);
				expect(result.backends).toHaveLength(1);
			} finally {
				try {
					rmSync(CONFIG_PATH, { force: true });
				} catch { /* ignore */ }
			}
		});
	});

	describe("savePersistedConfig", () => {
		it("should write config file", async () => {
			const config = { version: 1, backends: [{ baseUrl: "http://test:8080/v1", apiKey: "key1" }] };
			try {
				await savePersistedConfig(config);
				const result = await loadPersistedConfig();
				expect(result.version).toBe(CONFIG_VERSION);
				expect(result.backends).toHaveLength(1);
			} finally {
				try {
					rmSync(CONFIG_PATH, { force: true });
				} catch { /* ignore */ }
			}
		});
	});

	describe("resolveConfig", () => {
		it("should use LLAMA_BASE_URL env var in single-backend mode with 'llama-cpp'", async () => {
			process.env.LLAMA_BASE_URL = "http://env-server:8080/v1";
			const result = await resolveConfig();
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
			mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(config));

			try {
				const result = await resolveConfig();
				expect(result).toHaveLength(2);
				expect(result[0].baseUrl).toBe("http://local:8080/v1");
				expect(result[0].providerId).toBe("llama-cpp-0");
				expect(result[1].baseUrl).toBe("http://remote:8080/v1");
				expect(result[1].providerId).toBe("llama-cpp-1");
			} finally {
				rmSync(CONFIG_PATH, { force: true });
			}
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
			const modelsPath = join(homedir(), ".pi", "agent", "models.json");
			writeFileSync(modelsPath, JSON.stringify(modelsJson));

			try {
				const result = await resolveConfig();
				expect(result).toHaveLength(1);
				expect(result[0].baseUrl).toBe("http://models-json:8080/v1");
				expect(result[0].providerId).toBe("llama-cpp");
			} finally {
				rmSync(modelsPath, { force: true });
			}
		});

		it("should fall back to defaults with 'llama-cpp'", async () => {
			// Ensure no env var and no config file
			delete process.env.LLAMA_BASE_URL;
			try {
				rmSync(CONFIG_PATH, { force: true });
			} catch { /* ignore */ }

			const modelsPath = join(homedir(), ".pi", "agent", "models.json");
			try {
				rmSync(modelsPath, { force: true });
			} catch { /* ignore */ }

			const result = await resolveConfig();
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe(DEFAULT_BASE_URL);
			expect(result[0].providerId).toBe("llama-cpp");
		});

		it("should prefer env var over persisted config", async () => {
			const config = {
				version: 1,
				backends: [{ baseUrl: "http://persisted:8080/v1" }],
			};
			mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(config));

			process.env.LLAMA_BASE_URL = "http://env-overrides:8080/v1";
			const result = await resolveConfig();
			expect(result).toHaveLength(1);
			expect(result[0].baseUrl).toBe("http://env-overrides:8080/v1");
			expect(result[0].providerId).toBe("llama-cpp");
			rmSync(CONFIG_PATH, { force: true });
		});
	});
});
