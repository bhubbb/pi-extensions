/**
 * Tests for config resolution.
 *
 * Uses temp directories so tests never touch the real pi-llama.json.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_KEY, resolveSingleKey, resolveStatsBackends } from "../src/config";

// ---------------------------------------------------------------------------
// Temp-directory fixture
// ---------------------------------------------------------------------------

let TEST_DIR: string;
let TEST_CONFIG_PATH: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "pi-llama-stats-test-"));
  TEST_CONFIG_PATH = join(TEST_DIR, "pi-llama.json");
  // Clean up env vars before each test.
  delete process.env.LLAMA_BASE_URL;
  delete process.env.LLAMA_API_KEY;
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  delete process.env.LLAMA_BASE_URL;
  delete process.env.LLAMA_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveSingleKey", () => {
  it("returns default when input is undefined", () => {
    expect(resolveSingleKey()).toBe(DEFAULT_API_KEY);
  });

  it("returns default when input is empty string", () => {
    expect(resolveSingleKey("")).toBe(DEFAULT_API_KEY);
  });

  it("strips ! prefix for literal values", () => {
    expect(resolveSingleKey("!my-literal-key")).toBe("my-literal-key");
  });

  it("resolves env var name to its value", () => {
    process.env.MY_TEST_KEY = "secret-from-env";
    expect(resolveSingleKey("MY_TEST_KEY")).toBe("secret-from-env");
    delete process.env.MY_TEST_KEY;
  });

  it("returns literal when env var name is not found", () => {
    expect(resolveSingleKey("NONEXISTENT_VAR")).toBe("NONEXISTENT_VAR");
  });
});

describe("resolveStatsBackends", () => {
  it("returns single backend when LLAMA_BASE_URL env var is set", async () => {
    process.env.LLAMA_BASE_URL = "http://env-server:8080/v1";
    const result = await resolveStatsBackends();
    expect(result).toHaveLength(1);
    expect(result[0].providerId).toBe("llama-cpp");
    expect(result[0].baseUrl).toBe("http://env-server:8080/v1");
    expect(result[0].rootUrl).toBe("http://env-server:8080");
    expect(result[0].authHeader).toBe(false);
  });

  it("resolves LLAMA_API_KEY env var for the key", async () => {
    process.env.LLAMA_BASE_URL = "http://env-server:8080/v1";
    process.env.LLAMA_API_KEY = "env-key";
    const result = await resolveStatsBackends();
    expect(result[0].apiKey).toBe("env-key");
  });

  it("uses persisted config backends with numbered IDs", async () => {
    const config = {
      version: 1,
      backends: [
        { baseUrl: "http://local:8080/v1", apiKey: "local-key" },
        { baseUrl: "http://remote:8081/v1", apiKey: "remote-key", authHeader: true },
      ],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result).toHaveLength(2);
    expect(result[0].providerId).toBe("llama-cpp-0");
    expect(result[0].baseUrl).toBe("http://local:8080/v1");
    expect(result[0].rootUrl).toBe("http://local:8080");
    expect(result[0].apiKey).toBe("local-key");
    expect(result[0].authHeader).toBe(false);

    expect(result[1].providerId).toBe("llama-cpp-1");
    expect(result[1].baseUrl).toBe("http://remote:8081/v1");
    expect(result[1].rootUrl).toBe("http://remote:8081");
    expect(result[1].apiKey).toBe("remote-key");
    expect(result[1].authHeader).toBe(true);
  });

  it("strips trailing /v1 and slashes from rootUrl", async () => {
    const config = {
      version: 1,
      backends: [{ baseUrl: "http://local:8080/v1///" }],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result[0].baseUrl).toBe("http://local:8080/v1");
    expect(result[0].rootUrl).toBe("http://local:8080");
  });

  it("returns empty array when no config file and no env vars", async () => {
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result).toHaveLength(0);
  });

  it("prefers env var over persisted config", async () => {
    const config = {
      version: 1,
      backends: [{ baseUrl: "http://persisted:8080/v1" }],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    process.env.LLAMA_BASE_URL = "http://env-overrides:8080/v1";
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result).toHaveLength(1);
    expect(result[0].baseUrl).toBe("http://env-overrides:8080/v1");
    expect(result[0].providerId).toBe("llama-cpp");
  });

  it("skips backends without baseUrl", async () => {
    const config = {
      version: 1,
      backends: [
        { baseUrl: "http://valid:8080/v1" },
        { apiKey: "no-url-key" }, // Missing baseUrl — should be skipped
        { baseUrl: "http://also-valid:8081/v1" },
      ],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result).toHaveLength(2);
    expect(result[0].providerId).toBe("llama-cpp-0");
    expect(result[1].providerId).toBe("llama-cpp-1");
  });

  it("tolerates malformed config file (returns empty)", async () => {
    await writeFile(TEST_CONFIG_PATH, "not valid json {{{");
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result).toHaveLength(0);
  });

  it("resolves apiKey from env var reference in persisted config", async () => {
    process.env.MY_LLAMA_KEY = "key-from-env-var";
    const config = {
      version: 1,
      backends: [{ baseUrl: "http://local:8080/v1", apiKey: "MY_LLAMA_KEY" }],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result[0].apiKey).toBe("key-from-env-var");
    delete process.env.MY_LLAMA_KEY;
  });

  it("resolves !-prefixed apiKey as literal", async () => {
    const config = {
      version: 1,
      backends: [{ baseUrl: "http://local:8080/v1", apiKey: "!literal-key" }],
    };
    await writeFile(TEST_CONFIG_PATH, JSON.stringify(config));
    const result = await resolveStatsBackends(TEST_CONFIG_PATH);
    expect(result[0].apiKey).toBe("literal-key");
  });
});
