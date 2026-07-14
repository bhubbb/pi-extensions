/**
 * Tests for stats fetching and parsing (llama-app router API).
 *
 * Uses a mocked fetch function so no live server is needed.
 * Tests the per-model /slots?model=<id> fetch path and error isolation.
 */
import { describe, expect, it } from "bun:test";
import type { StatsBackend } from "../src/config";
import { fetchBackendStats, type BackendStats } from "../src/stats";

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

/** Build a mock fetch that returns predefined responses. Supports query params. */
function mockFetch(responses: Record<string, { status: number; json?: unknown }>): typeof fetch {
  return async (url: string | URL | Request, _init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : (url as URL).toString();
    const parsed = new URL(urlString);
    const key = parsed.pathname + parsed.search;
    // Also try pathname-only match for backwards compat.
    const resp = responses[key] ?? responses[parsed.pathname];

    if (!resp) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(JSON.stringify(resp.json), { status: resp.status });
  };
}

// ---------------------------------------------------------------------------
// parseProps
// ---------------------------------------------------------------------------

describe("parseProps", () => {
  it("parses router-level props with role field", async () => {
    const fetchFn = mockFetch({
      "/props": {
        status: 200,
        json: {
          build_info: "b9870-2d973636e",
          role: "router",
          total_slots: 4,
          is_sleeping: false,
        },
      },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.props).toBeDefined();
    expect(result.props!.buildInfo).toBe("b9870-2d973636e");
    expect(result.props!.role).toBe("router");
    expect(result.props!.totalSlots).toBe(4);
    expect(result.props!.isSleeping).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseModels
// ---------------------------------------------------------------------------

describe("parseModels", () => {
  it("parses /v1/models with status.value", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": {
        status: 200,
        json: {
          data: [
            {
              id: "unsloth/gemma-2-2b:Q4_K_M",
              status: { value: "loaded" },
              meta: { n_params: 2611000000, size: 1700000000, n_ctx_train: 8192, n_ctx: 4096 },
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
    expect(result.models![0].nCtx).toBe(4096);
    expect(result.models![1].status).toBe("unloaded");
  });

  it("handles string status (not object)", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": {
        status: 200,
        json: { data: [{ id: "model", status: "loaded" }] },
      },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.models![0].status).toBe("loaded");
  });

  it("parses architecture info from meta", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": {
        status: 200,
        json: {
          data: [
            {
              id: "model",
              status: "loaded",
              meta: {
                architecture: {
                  input_modalities: ["text"],
                  output_modalities: ["text"],
                },
              },
            },
          ],
        },
      },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.models![0].architecture).toEqual({
      input_modalities: ["text"],
      output_modalities: ["text"],
    });
  });
});

// ---------------------------------------------------------------------------
// parseSlots — array next_token
// ---------------------------------------------------------------------------

describe("parseSlots (router API — array next_token)", () => {
  it("parses next_token as array", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": {
        status: 200,
        json: {
          data: [
            { id: "model-a", status: "loaded" },
          ],
        },
      },
      "/health": { status: 200, json: { status: "ok" } },
      "/slots?model=model-a": {
        status: 200,
        json: [
          {
            id: 0,
            is_processing: true,
            n_ctx: 131072,
            speculative: true,
            next_token: [{ n_decoded: 154, n_remain: 18405, has_next_token: true }],
            params: {
              n_prompt_tokens: 106376,
              n_prompt_tokens_processed: 1684,
              n_prompt_tokens_cache: 104692,
            },
          },
          { id: 1, is_processing: false, n_ctx: 131072 },
        ],
      },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.modelSlots).toBeDefined();
    expect(result.modelSlots!["model-a"]).toHaveLength(2);

    const slot0 = result.modelSlots!["model-a"][0];
    expect(slot0.id).toBe(0);
    expect(slot0.isProcessing).toBe(true);
    expect(slot0.nCtx).toBe(131072);
    expect(slot0.speculative).toBe(true);
    expect(slot0.nDecoded).toBe(154);
    expect(slot0.nRemain).toBe(18405);
    expect(slot0.hasNextToken).toBe(true);
    expect(slot0.nPromptTokens).toBe(106376);
    expect(slot0.nPromptTokensProcessed).toBe(1684);
    expect(slot0.nPromptTokensCache).toBe(104692);

    const slot1 = result.modelSlots!["model-a"][1];
    expect(slot1.isProcessing).toBe(false);
    expect(slot1.nDecoded).toBeUndefined();
  });

  it("handles classic object next_token (backward compat)", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": {
        status: 200,
        json: {
          data: [{ id: "model-a", status: "loaded" }],
        },
      },
      "/health": { status: 200, json: { status: "ok" } },
      "/slots?model=model-a": {
        status: 200,
        json: [
          {
            id: 0,
            is_processing: true,
            next_token: { n_decoded: 42, n_remain: 158 },
          },
        ],
      },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.modelSlots!["model-a"][0].nDecoded).toBe(42);
    expect(result.modelSlots!["model-a"][0].nRemain).toBe(158);
  });
});

// ---------------------------------------------------------------------------
// fetchBackendStats — per-model /slots?model=<id>
// ---------------------------------------------------------------------------

describe("fetchBackendStats — per-model slots", () => {
  it("fetches /slots?model=<id> for each loaded model", async () => {
    const fetchCalls: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      fetchCalls.push(urlString);
      const parsed = new URL(urlString);

      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (parsed.pathname === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "model-a", status: "loaded" },
            { id: "model-b", status: "loaded" },
          ],
        }), { status: 200 });
      }
      if (parsed.pathname === "/slots") {
        return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);

    // Should have fetched /slots?model=model-a and /slots?model=model-b.
    expect(fetchCalls).toContain("http://localhost:8080/slots?model=model-a");
    expect(fetchCalls).toContain("http://localhost:8080/slots?model=model-b");
  });

  it("skips unloaded models (no slots fetch)", async () => {
    const fetchCalls: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      fetchCalls.push(urlString);
      const parsed = new URL(urlString);

      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (parsed.pathname === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "model-a", status: "loaded" },
            { id: "model-b", status: "unloaded" },
          ],
        }), { status: 200 });
      }
      if (parsed.pathname === "/slots") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);

    // Should fetch slots for model-a but NOT model-b (unloaded).
    expect(fetchCalls).toContain("http://localhost:8080/slots?model=model-a");
    expect(fetchCalls).not.toContain("http://localhost:8080/slots?model=model-b");
  });

  it("fetches slots for models with non-standard statuses (e.g. ready, sleeping)", async () => {
    const fetchCalls: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      fetchCalls.push(urlString);
      const parsed = new URL(urlString);

      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (parsed.pathname === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "model-ready", status: "ready" },
            { id: "model-sleeping", status: "sleeping" },
            { id: "model-unloaded", status: "unloaded" },
          ],
        }), { status: 200 });
      }
      if (parsed.pathname === "/slots") {
        return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);

    // Should fetch slots for ready and sleeping, skip unloaded.
    expect(fetchCalls).toContain("http://localhost:8080/slots?model=model-ready");
    expect(fetchCalls).toContain("http://localhost:8080/slots?model=model-sleeping");
    expect(fetchCalls).not.toContain("http://localhost:8080/slots?model=model-unloaded");
  });

  it("builds keyed modelSlots map", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      const parsed = new URL(urlString);

      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (parsed.pathname === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "model-x", status: "loaded" },
          ],
        }), { status: 200 });
      }
      if (parsed.pathname === "/slots" && parsed.search === "?model=model-x") {
        return new Response(JSON.stringify([
          { id: 0, is_processing: true, n_ctx: 8192 },
          { id: 1, is_processing: false },
        ]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.modelSlots).toBeDefined();
    expect(Object.keys(result.modelSlots!)).toContain("model-x");
    expect(result.modelSlots!["model-x"]).toHaveLength(2);
    expect(result.modelSlots!["model-x"][0].isProcessing).toBe(true);
    expect(result.modelSlots!["model-x"][1].isProcessing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resilience: partial failure, empty set, timeout
// ---------------------------------------------------------------------------

describe("fetchBackendStats — resilience", () => {
  it("partial failure: one model /slots fails, others still render", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      const parsed = new URL(urlString);

      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (parsed.pathname === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "model-a", status: "loaded" },
            { id: "model-b", status: "loaded" },
            { id: "model-c", status: "loaded" },
          ],
        }), { status: 200 });
      }
      // model-a succeeds, model-b returns 500, model-c succeeds.
      if (parsed.pathname === "/slots" && parsed.search === "?model=model-a") {
        return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
      }
      if (parsed.pathname === "/slots" && parsed.search === "?model=model-b") {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (parsed.pathname === "/slots" && parsed.search === "?model=model-c") {
        return new Response(JSON.stringify([{ id: 2, is_processing: true }]), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);

    // Should have all 3 models.
    expect(result.models).toHaveLength(3);

    // model-a and model-c should have slots; model-b should have empty array.
    expect(result.modelSlots!["model-a"]).toHaveLength(1);
    expect(result.modelSlots!["model-b"]).toHaveLength(0); // Failed → empty
    expect(result.modelSlots!["model-c"]).toHaveLength(1);

    // No error set — backend is reachable.
    expect(result.error).toBeUndefined();
    expect(result.health).toEqual({ status: "ok" });
  });

  it("empty set: /v1/models returns no models", async () => {
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.models).toEqual([]);
    expect(result.modelSlots).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("sets error when backend is unreachable", async () => {
    const fetchFn = mockFetch({}); // All 404

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeDefined();
    expect(result.props).toBeUndefined();
    expect(result.health).toBeUndefined();
  });

  it("sets error when /health fails even if /props and /v1/models succeed", async () => {
    // /health failure is the canonical unreachable signal.
    const fetchFn = mockFetch({
      "/props": { status: 200, json: { build_info: "b1" } },
      "/v1/models": { status: 200, json: { data: [{ id: "m", status: "loaded" }] } },
    });
    // /health not in map → 404 → treated as failed.

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeDefined();
    expect(result.health).toBeUndefined();
  });

  it("sets error when /health succeeds but /props AND /v1/models both fail", async () => {
    // If we can't get any data from the backend (only health works), it's
    // effectively unreachable for the stats view's purposes.
    const fetchFn = mockFetch({
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeDefined();
  });

  it("does NOT set error when all three core endpoints succeed (baseline)", async () => {
    // Baseline check: when /props, /v1/models, and /health all succeed,
    // the backend is reachable and no error is set.
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeUndefined();
    expect(result.health).toEqual({ status: "ok" });
  });

  it("sets error when /v1/models fails (even if /props and /health succeed)", async () => {
    // /v1/models is the root models endpoint — if it fails, the stats view
    // can't show any model data, so treat the backend as unreachable rather
    // than rendering an empty block.
    const fetchFn = mockFetch({
      "/props": { status: 200, json: { build_info: "b1" } },
      "/health": { status: 200, json: { status: "ok" } },
    });
    // /v1/models not in map → 404

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeDefined();
    expect(result.health).toEqual({ status: "ok" }); // /health still parsed
    expect(result.props).toBeDefined();
  });

  it("does not set error when /props fails but /v1/models and /health succeed", async () => {
    // /props failure is tolerated — the other endpoints can still provide
    // the data the view needs (just no build info).
    const fetchFn = mockFetch({
      "/v1/models": { status: 200, json: { data: [{ id: "m", status: "loaded" }] } },
      "/health": { status: 200, json: { status: "ok" } },
    });
    // /props not in map → 404

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.health).toEqual({ status: "ok" });
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort(); // Abort immediately

    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, controller.signal, fetchFn);
    // The mock doesn't check the signal, but passing an aborted signal
    // should not crash.
    expect(result.backend).toBe(FAKE_BACKEND);
    expect(result.fetchedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

describe("fetchBackendStats — timestamps", () => {
  it("sets fetchedAt timestamp", async () => {
    const before = Date.now();
    const fetchFn = mockFetch({
      "/props": { status: 200, json: {} },
      "/v1/models": { status: 200, json: { data: [] } },
      "/health": { status: 200, json: { status: "ok" } },
    });

    const result = await fetchBackendStats(FAKE_BACKEND, undefined, fetchFn);
    const after = Date.now();
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAt).toBeLessThanOrEqual(after);
  });
});
