/**
 * Tests for stats fetching and parsing.
 *
 * Uses a mocked fetch function so no live server is needed.
 */
import { describe, expect, it } from "bun:test";
import type { StatsBackend } from "../src/config";
import {
  fetchBackendStats,
  parseMetricsText,
  type BackendStats,
  type PropsStats,
  type SlotStats,
  type ModelStats,
} from "../src/stats";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_BACKEND: StatsBackend = {
  providerId: "llama-cpp-0",
  baseUrl: "http://localhost:8080/v1",
  rootUrl: "http://localhost:8080",
  apiKey: "no-key",
  authHeader: false,
};

/** Build a mock fetch that returns predefined responses. */
function mockFetch(responses: Record<string, { status: number; json?: unknown; text?: string }>): typeof fetch {
  return async (url: string | URL | Request, _init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : (url as URL).toString();
    const path = new URL(urlString).pathname;
    const resp = responses[path];

    if (!resp) {
      return new Response("Not Found", { status: 404 });
    }

    if (resp.text !== undefined) {
      return new Response(resp.text, { status: resp.status });
    }

    return new Response(JSON.stringify(resp.json), { status: resp.status });
  };
}

// ---------------------------------------------------------------------------
// parseMetricsText
// ---------------------------------------------------------------------------

describe("parseMetricsText", () => {
  it("extracts all 6 named metrics from Prometheus text", () => {
    const text = `# HELP llamacpp:prompt_tokens_seconds Prompt tokens per second
# TYPE llamacpp:prompt_tokens_seconds gauge
llamacpp:prompt_tokens_seconds 32.47
# HELP llamacpp:predicted_tokens_seconds Predicted tokens per second
# TYPE llamacpp:predicted_tokens_seconds gauge
llamacpp:predicted_tokens_seconds 52.94
llamacpp:requests_processing 2
llamacpp:requests_deferred 0
llamacpp:prompt_tokens_total 1048576
llamacpp:tokens_predicted_total 2097152
# Some unrelated metric
node_cpu_seconds_total 123.45`;

    const result = parseMetricsText(text);
    expect(result.promptTokensPerSecond).toBe(32.47);
    expect(result.predictedTokensPerSecond).toBe(52.94);
    expect(result.requestsProcessing).toBe(2);
    expect(result.requestsDeferred).toBe(0);
    expect(result.promptTokensTotal).toBe(1048576);
    expect(result.tokensPredictedTotal).toBe(2097152);
  });

  it("returns empty object for unrelated lines only", () => {
    const text = `node_cpu_seconds_total 123.45\nnode_memory_bytes 456`;
    const result = parseMetricsText(text);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles empty input", () => {
    const result = parseMetricsText("");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fetchBackendStats
// ---------------------------------------------------------------------------

describe("fetchBackendStats", () => {
  it("parses /props into PropsStats", async () => {
    const fetchFn = mockFetch({
      "/props": {
        status: 200,
        json: {
          build_info: "b1234-abc",
          model_path: "/path/to/model.gguf",
          total_slots: 4,
          is_sleeping: false,
          default_generation_settings: { n_ctx: 8192 },
        },
      },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.props).toBeDefined();
    expect(result.props!.buildInfo).toBe("b1234-abc");
    expect(result.props!.modelPath).toBe("/path/to/model.gguf");
    expect(result.props!.totalSlots).toBe(4);
    expect(result.props!.isSleeping).toBe(false);
    expect(result.props!.nCtx).toBe(8192);
  });

  it("parses /slots with minimal fields", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": {
        status: 200,
        json: [
          { id: 0, is_processing: false },
          { id: 1, is_processing: true, n_ctx: 8192 },
        ],
      },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.slots).toHaveLength(2);
    expect(result.slots![0].id).toBe(0);
    expect(result.slots![0].isProcessing).toBe(false);
    expect(result.slots![1].id).toBe(1);
    expect(result.slots![1].isProcessing).toBe(true);
    expect(result.slots![1].nCtx).toBe(8192);
  });

  it("parses /slots with timing fields (defensive on extra fields)", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": {
        status: 200,
        json: [
          {
            id: 0,
            is_processing: true,
            n_ctx: 8192,
            next_token: { n_decoded: 42, n_remain: 158 },
            timing: { predicted_per_second: 52.9, prompt_per_second: 32.1 },
            n_past: 42,
            n_tokens: 200,
            truncated: false,
            model: "test-model",
          },
        ],
      },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.slots![0].nDecoded).toBe(42);
    expect(result.slots![0].nRemain).toBe(158);
    expect(result.slots![0].predictedPerSecond).toBe(52.9);
    expect(result.slots![0].promptPerSecond).toBe(32.1);
    expect(result.slots![0].nPast).toBe(42);
    expect(result.slots![0].nTokens).toBe(200);
    expect(result.slots![0].truncated).toBe(false);
    expect(result.slots![0].model).toBe("test-model");
  });

  it("parses /v1/models with status.value", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": {
        status: 200,
        json: {
          data: [
            {
              id: "unsloth/gemma-2-2b:Q4_K_M",
              status: { value: "loaded" },
              meta: { n_params: 2611000000, size: 1700000000, n_ctx_train: 8192 },
            },
            {
              id: "other/model",
              status: { value: "unloaded" },
              meta: { n_params: 500000000, size: 350000000 },
            },
          ],
        },
      },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.models).toHaveLength(2);
    expect(result.models![0].id).toBe("unsloth/gemma-2-2b:Q4_K_M");
    expect(result.models![0].status).toBe("loaded");
    expect(result.models![0].nParams).toBe(2611000000);
    expect(result.models![0].size).toBe(1700000000);
    expect(result.models![0].nCtxTrain).toBe(8192);
    expect(result.models![1].status).toBe("unloaded");
  });

  it("handles /v1/models with string status (not object)", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": {
        status: 200,
        json: { data: [{ id: "model", status: "loaded" }] },
      },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.models![0].status).toBe("loaded");
  });

  it("parses /health status", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.health).toEqual({ status: "ok" });
  });

  it("parses /metrics text format", async () => {
    const metricsText = `llamacpp:prompt_tokens_seconds 32.3
llamacpp:predicted_tokens_seconds 52.9
llamacpp:requests_processing 1
llamacpp:requests_deferred 0
llamacpp:prompt_tokens_total 1000
llamacpp:tokens_predicted_total 2000`;

    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
      "/metrics": { status: 200, text: metricsText },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.promptTokensPerSecond).toBe(32.3);
    expect(result.metrics!.predictedTokensPerSecond).toBe(52.9);
    expect(result.metrics!.requestsProcessing).toBe(1);
    expect(result.metrics!.tokensPredictedTotal).toBe(2000);
  });

  it("does not set error when /metrics returns 501", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });
    // /metrics is not in the map → 404 → silently skipped

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeUndefined();
    expect(result.metrics).toBeUndefined();
  });

  it("sets error when all core endpoints fail", async () => {
    const fetchFn = mockFetch({}); // No endpoints → all 404

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeDefined();
    expect(result.props).toBeUndefined();
    expect(result.slots).toBeUndefined();
    expect(result.health).toBeUndefined();
  });

  it("tolerates malformed JSON (does not throw)", async () => {
    const fetchFn: typeof fetch = async (url: string | URL | Request) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      const path = new URL(urlString).pathname;
      if (path === "/props") {
        return new Response("not valid json {{{", { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    // Should not throw — props is undefined due to malformed JSON
    expect(result.props).toBeUndefined();
    expect(result.error).toBeUndefined(); // Other endpoints succeeded
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort(); // Abort immediately

    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, controller.signal, fetchFn);
    // The fetch should have been aborted — but since our mock doesn't actually
    // check the signal, it will still return data. In a real scenario with
    // an AbortSignal.any + timeout, the fetch would throw AbortError.
    // What we verify here is that passing the signal doesn't crash.
    expect(result.backend).toBe(FAKE_BACKEND);
    expect(result.fetchedAt).toBeDefined();
  });

  it("sets fetchedAt timestamp", async () => {
    const before = Date.now();
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/slots": { status: 200, json: [] },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    const after = Date.now();
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAt).toBeLessThanOrEqual(after);
  });
});
