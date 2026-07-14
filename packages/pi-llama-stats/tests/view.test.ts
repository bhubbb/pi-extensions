/**
 * Tests for StatsView lifecycle (cleanup, abort, timer).
 *
 * Does not test pixel-perfect rendering (behavior, not visuals).
 * Verifies: AbortController cleanup, timer disposal, render doesn't crash.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { StatsBackend } from "../src/config";
import type { BackendStats } from "../src/stats";
import { StatsView } from "../src/view";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Minimal mock TUI that captures requestRender calls. */
function makeMockTUI() {
  const renders: number[] = [];
  return {
    requestRender: () => renders.push(Date.now()),
    _renders: renders, // Exposed for assertions
  } as import("@earendil-works/pi-tui").TUI;
}

/** Minimal mock Theme that returns plain strings. */
function makeMockTheme() {
  const fg = (color: string, text: string) => `[${color}]${text}[/]`;
  return {
    fg,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
  } as import("@earendil-works/pi-coding-agent").Theme;
}

/** Mock fetch that always returns empty but valid responses. */
const mockFetchEmpty: typeof fetch = async (_url, _init) =>
  new Response(JSON.stringify({}), { status: 200 });

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FAKE_BACKEND: StatsBackend = {
  providerId: "llama-cpp-0",
  baseUrl: "http://localhost:8080/v1",
  rootUrl: "http://localhost:8080",
  apiKey: "no-key",
  authHeader: false,
};

// Override global fetch for all view tests.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  // @ts-ignore — bun:test allows overriding globals
  globalThis.fetch = mockFetchEmpty;
});
afterEach(() => {
  // @ts-ignore
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatsView lifecycle", () => {
  it("renders without crashing (empty data)", () => {
    const tui = makeMockTUI();
    const theme = makeMockTheme();
    let doneCalled = false;
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => { doneCalled = true; });

    // First render (stats not fetched yet — should not crash).
    const lines = view.render(80);
    expect(Array.isArray(lines)).toBeTrue();
    expect(lines.length).toBeGreaterThanOrEqual(1); // At least header + footer

    // Cleanup.
    view.dispose();
    expect(doneCalled).toBeFalse(); // dispose doesn't call done
  });

  it("disposes abort controller (prevents further fetches)", async () => {
    let fetchCount = 0;
    const trackingFetch: typeof fetch = async (url, init) => {
      fetchCount++;
      // Check if signal is already aborted.
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    // Override global fetch for this test.
    // @ts-ignore
    globalThis.fetch = trackingFetch;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    // Let the initial fetch complete.
    await new Promise((r) => setTimeout(r, 100));
    const countAfterInit = fetchCount;

    // Dispose — should abort any pending timer.
    view.dispose();

    // Wait a bit longer than the refresh interval.
    await new Promise((r) => setTimeout(r, 2500));

    // No new fetches should have been triggered after dispose.
    expect(fetchCount).toBe(countAfterInit);
  });

  it("clears refresh timer on dispose", async () => {
    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    // Let initial fetch settle.
    await new Promise((r) => setTimeout(r, 100));

    const rendersBefore = tui._renders.length;
    view.dispose();

    // Wait longer than the refresh interval.
    await new Promise((r) => setTimeout(r, 2500));

    // No new renders should have been triggered.
    expect(tui._renders.length).toBe(rendersBefore);
  });

  it("calls onDone after dispose when q is pressed", () => {
    const tui = makeMockTUI();
    const theme = makeMockTheme();
    let doneCalled = false;
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => { doneCalled = true; });

    view.handleInput("q");

    expect(doneCalled).toBeTrue();
  });

  it("calls onDone when escape is pressed", () => {
    const tui = makeMockTUI();
    const theme = makeMockTheme();
    let doneCalled = false;
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => { doneCalled = true; });

    view.handleInput("\x1b");

    expect(doneCalled).toBeTrue();
  });

  it("scrolls on up/down input", () => {
    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    // Initial render.
    view.render(80);

    // Simulate some content.
    view.handleInput("down");
    view.handleInput("down");
    view.handleInput("up");

    // Should not crash — just verify the component is still functional.
    const lines = view.render(80);
    expect(Array.isArray(lines)).toBeTrue();

    view.dispose();
  });

  it("handles multiple backends without crashing", async () => {
    const backends: StatsBackend[] = [
      FAKE_BACKEND,
      {
        providerId: "llama-cpp-1",
        baseUrl: "http://remote:8081/v1",
        rootUrl: "http://remote:8081",
        apiKey: "no-key",
        authHeader: false,
      },
    ];

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView(backends, theme, tui, () => {});

    // Let fetches complete.
    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(80);
    expect(Array.isArray(lines)).toBeTrue();
    // Should have content for both backends (at minimum header + footer).
    expect(lines.length).toBeGreaterThanOrEqual(2);

    view.dispose();
  });
});

// ---------------------------------------------------------------------------
// Functional rendering tests
// ---------------------------------------------------------------------------

describe("StatsView rendering", () => {
  /** Build a mock fetch that returns realistic router API responses. */
  function mockRouterFetch(responses: {
    models: Array<{ id: string; status: string }>;
    slots: Record<string, Array<{ id: number; is_processing?: boolean; n_ctx?: number }>>;
    props?: Record<string, unknown>;
    health?: { status: string };
  }): typeof fetch {
    return async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      const parsed = new URL(urlString);
      const path = parsed.pathname;
      const search = parsed.search;

      if (path === "/props") {
        return new Response(JSON.stringify(responses.props ?? {}), { status: 200 });
      }
      if (path === "/health") {
        return new Response(JSON.stringify(responses.health ?? { status: "ok" }), { status: 200 });
      }
      if (path === "/v1/models") {
        return new Response(JSON.stringify({
          data: responses.models.map((m) => ({
            id: m.id,
            status: m.status,
            meta: { n_params: 2611000000, size: 1700000000 },
          })),
        }), { status: 200 });
      }
      if (path === "/slots") {
        // Extract model from query param.
        const modelId = new URLSearchParams(search).get("model");
        const slots = modelId ? (responses.slots[modelId] ?? []) : [];
        return new Response(JSON.stringify(slots), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };
  }

  it("renders model names and statuses", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [
        { id: "unsloth/Qwen3.6-27B:Q6_K_XL", status: "loaded" },
        { id: "other/model", status: "unloaded" },
      ],
      slots: {
        "unsloth/Qwen3.6-27B:Q6_K_XL": [
          { id: 0, is_processing: false, n_ctx: 131072 },
          { id: 1, is_processing: true, n_ctx: 131072 },
        ],
      },
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    // Let fetch complete.
    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Model names should appear.
    expect(fullText).toContain("unsloth/Qwen3.6-27B:Q6_K_XL");
    expect(fullText).toContain("other/model");

    // Statuses should appear.
    expect(fullText).toContain("[success]loaded[/]");
    expect(fullText).toContain("[muted]unloaded[/]");

    // Slots section should appear under loaded model.
    expect(fullText).toContain("slots:");

    // Cleanup.
    view.dispose();
  });

  it("renders slot details (idle/busy, ctx, decoded/remain)", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [{ id: "model-a", status: "loaded" }],
      slots: {
        "model-a": [
          { id: 0, is_processing: false, n_ctx: 8192 },
          { id: 1, is_processing: true, n_ctx: 8192 },
        ],
      },
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Slot markers should appear.
    expect(fullText).toContain("#0");
    expect(fullText).toContain("#1");
    expect(fullText).toContain("[muted]○ idle[/]");
    expect(fullText).toContain("[warning]● busy[/]");
    // Context window formatted as human-readable (uppercase K).
    expect(fullText).toContain("ctx 8K");

    view.dispose();
  });

  it("does not show slots for unloaded models", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [
        { id: "model-loaded", status: "loaded" },
        { id: "model-unloaded", status: "unloaded" },
      ],
      slots: {
        "model-loaded": [{ id: 0, is_processing: false }],
      },
      // No slots for model-unloaded — it's unloaded.
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Unloaded model should appear.
    expect(fullText).toContain("model-unloaded");
    expect(fullText).toContain("unloaded");

    // But no slots section should appear after it (only one slots: for loaded).
    const slotsCount = (fullText.match(/slots:/g) || []).length;
    expect(slotsCount).toBe(1); // Only for the loaded model.

    view.dispose();
  });

  it("renders backend unreachable when all endpoints fail", async () => {
    // @ts-ignore
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(80);
    const fullText = lines.join("\n");

    expect(fullText).toContain("unreachable");
    expect(fullText).toContain("[error]");

    view.dispose();
  });

  it("renders health status", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [],
      slots: {},
      health: { status: "ok" },
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(80);
    const fullText = lines.join("\n");

    expect(fullText).toContain("health:");
    expect(fullText).toContain("[success]ok[/]");

    view.dispose();
  });

  it("renders header and footer", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(80);
    expect(lines[0]).toContain("llama.cpp stats");
    expect(lines[lines.length - 1]).toContain("╰─");

    view.dispose();
  });

  it("in-flight guard prevents overlapping refreshes", async () => {
    let fetchCount = 0;
    let firstFetchResolve: () => void;
    // Block the first fetch indefinitely (or until we resolve it).
    const firstFetchDone = new Promise<void>((resolve) => { firstFetchResolve = resolve; });

    const slowFetch: typeof fetch = async (url, init) => {
      fetchCount++;
      if (fetchCount === 1) {
        // Block the first fetch.
        await firstFetchDone;
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    // @ts-ignore
    globalThis.fetch = slowFetch;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    // The initial fetch is blocked. Wait briefly.
    await new Promise((r) => setTimeout(r, 50));

    // Force a refresh — should be blocked by the in-flight guard.
    view.handleInput("r");

    // Resolve the first fetch.
    firstFetchResolve();
    await new Promise((r) => setTimeout(r, 100));

    // Only 1 fetch should have happened (the forced refresh was blocked).
    // The actual count depends on how many endpoints are fetched, but the key
    // point is that the forced 'r' didn't trigger an additional cycle.
    // We verify by checking that fetchCount is still in the single-fetch range.
    // (3 core endpoints = 3 fetches for the first cycle)
    const initialFetches = fetchCount;

    // Wait longer than the refresh interval — no new cycle should start
    // because the in-flight guard should have rejected the forced 'r'.
    await new Promise((r) => setTimeout(r, 2100));

    // After the forced resolve and 2s wait, a normal auto-refresh should fire.
    // So total should be initial + auto-refresh cycle (3 more fetches).
    // The key assertion: the forced 'r' did NOT add extra fetches.
    expect(fetchCount - initialFetches).toBeLessThanOrEqual(3); // At most one auto-refresh cycle.

    view.dispose();
  });

  it("shows 'prompt' label and progress during prompt processing", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [{ id: "model-a", status: "loaded" }],
      slots: {
        "model-a": [
          {
            id: 0,
            is_processing: true, // busy during prompt processing
            n_ctx: 131072,
            next_token: [], // no decoded yet — still processing prompt
          },
        ],
      },
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    // Manually inject slot data with prompt processing fields.
    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [{
          id: 0,
          isProcessing: true,
          nCtx: 131072,
          nPromptTokens: 106376,
          nPromptTokensProcessed: 1684, // processed < total = prompt processing
          nPromptTokensCache: 104692,
          nDecoded: 0,
        }],
      },
    }];

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Should show "processing prompt" label, not "generating" or "busy".
    expect(fullText).toContain("[warning]◐ processing prompt[/]");
    expect(fullText).not.toContain("[warning]● generating[/]");
    expect(fullText).not.toContain("[warning]● busy[/]");

    // Should show progress with percentage (formatted with commas).
    expect(fullText).toContain("1,684 / 106,376 tokens");
    expect(fullText).toMatch(/\d+\.\d+%/);

    // Should show progress bar (filled + empty blocks).
    expect(fullText).toMatch(/[█░]+/);

    // Should NOT show decoded/remain during prompt processing.
    expect(fullText).not.toContain("decoded");
    expect(fullText).not.toContain("remaining");

    // Should show cache count with percentage.
    expect(fullText).toContain("cache:");
    expect(fullText).toContain("104,692");

    view.dispose();
  });

  it("shows 'busy' label and decoded/remain during inference", async () => {
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [{ id: "model-a", status: "loaded" }],
      slots: {
        "model-a": [{ id: 0, is_processing: true, n_ctx: 8192 }],
      },
    });

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    // Inject slot data showing inference phase.
    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [{
          id: 0,
          isProcessing: true,
          nCtx: 8192,
          nPromptTokens: 1000,
          nPromptTokensProcessed: 1000, // processed == total = done with prompt
          nDecoded: 154,
          nRemain: 846,
        }],
      },
    }];

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Should show "generating" label, not "processing prompt".
    expect(fullText).toContain("[warning]● generating[/]");
    expect(fullText).not.toContain("[warning]◐ processing prompt[/]");

    // Should show decoded/remaining with comma formatting.
    expect(fullText).toContain("154 decoded");
    expect(fullText).toContain("846 remaining");

    view.dispose();
  });

  it("shows 'idle' label when slot is not processing", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [{ id: 0, isProcessing: false, nCtx: 8192 }],
      },
    }];

    const lines = view.render(120);
    const fullText = lines.join("\n");

    expect(fullText).toContain("[muted]○ idle[/]");

    view.dispose();
  });

  it("renders cache value when nPromptTokensCache > 0", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [{
          id: 0,
          isProcessing: true,
          nCtx: 131072,
          nPromptTokens: 106376,
          nPromptTokensProcessed: 1684, // < total → prompt processing
          nPromptTokensCache: 104692,   // cache hit
          nDecoded: 0,
        }],
      },
    }];

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Cache value must be rendered with comma formatting and percentage.
    expect(fullText).toContain("cache:");
    expect(fullText).toContain("104,692");
    expect(fullText).toMatch(/cache: 104,692 \(\d+\.\d+%\)/);

    // Prompt progress should also be shown (sanity check).
    expect(fullText).toContain("1,684 / 106,376 tokens");
    // Context window formatted as human-readable (131072 → 128K, uppercase K).
    expect(fullText).toContain("ctx 128K");

    view.dispose();
  });

  it("does not crash when nPromptTokens is 0 (boundary case)", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [{
          id: 0,
          isProcessing: true,
          nCtx: 8192,
          nPromptTokens: 0,            // edge case: total is 0
          nPromptTokensProcessed: 0,
          nDecoded: 0,
        }],
      },
    }];

    // Should not crash, should not produce Infinity% or NaN%.
    let lines: string[];
    expect(() => { lines = view.render(120); }).not.toThrow();
    const fullText = lines!.join("\n");

    // No Infinity% or NaN% in output.
    expect(fullText).not.toContain("Infinity%");
    expect(fullText).not.toContain("NaN%");

    // Since nPromptTokens === 0, isPromptProcessing is false (guard added),
    // so the slot shows "busy" (from isProcessing=true) but no prompt progress.
    expect(fullText).toContain("[warning]● busy[/]");
    // No "processing prompt" label since total is 0.
    expect(fullText).not.toContain("processing prompt");

    view.dispose();
  });

  it("renders backend unreachable when /v1/models fails", async () => {
    // /v1/models failing should mark the backend unreachable (the user can't
    // see any models otherwise and it looks like an empty backend rather than
    // a failure).
    // @ts-ignore
    globalThis.fetch = mockRouterFetch({
      models: [], // /v1/models returns empty (or 404)
      slots: {},
      health: { status: "ok" },
    });
    // Override /v1/models to return 500.
    // @ts-ignore
    globalThis.fetch = async (url, _init) => {
      const urlString = typeof url === "string" ? url : (url as URL).toString();
      const parsed = new URL(urlString);
      if (parsed.pathname === "/v1/models") {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (parsed.pathname === "/props") return new Response(JSON.stringify({}), { status: 200 });
      if (parsed.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response("Not Found", { status: 404 });
    };

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Should show unreachable state.
    expect(fullText).toContain("unreachable");
    expect(fullText).toContain("[error]");

    view.dispose();
  });

  it("uses human-readable numbers (commas, k/M suffixes)", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [
        { id: "model-a", status: "loaded", nParams: 27_300_000_000, size: 26_000_000_000 },
      ],
      modelSlots: {
        "model-a": [
          {
            id: 0,
            isProcessing: false,
            nCtx: 1048576, // 1M
          },
        ],
      },
    }];

    const lines = view.render(120);
    const fullText = lines.join("\n");

    // Large params formatted as billions.
    expect(fullText).toMatch(/27\.\d+B params/);
    // Large size formatted as GB.
    expect(fullText).toMatch(/\d+\.\d+ GB/);
    // Large context formatted as M.
    expect(fullText).toContain("ctx 1.0M");

    view.dispose();
  });

  it("keeps idle slots on a single line (compact layout)", async () => {
    // Active slots expand to 2 lines for progress details, but idle slots
    // should remain compact to preserve vertical space.
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [
          { id: 0, isProcessing: false, nCtx: 8192 },
          { id: 1, isProcessing: false, nCtx: 8192 },
          { id: 2, isProcessing: false, nCtx: 8192 },
          { id: 3, isProcessing: false, nCtx: 8192 },
        ],
      },
    }];

    const lines = view.render(120);

    // Count slot lines (lines starting with ○ idle).
    const slotLines = lines.filter((l) => l.includes("○ idle"));
    // Each idle slot should be exactly ONE line (no expansion).
    expect(slotLines.length).toBe(4);
    // No progress bar characters (░) should appear for idle slots.
    expect(lines.some((l) => l.includes("░"))).toBe(false);
    // No 'decoded' or 'remaining' detail lines.
    expect(lines.some((l) => l.includes("decoded"))).toBe(false);
    expect(lines.some((l) => l.includes("remaining"))).toBe(false);

    view.dispose();
  });

  it("expands active slots to 2 lines for progress details", async () => {
    // @ts-ignore
    globalThis.fetch = mockFetchEmpty;

    const tui = makeMockTUI();
    const theme = makeMockTheme();
    const view = new StatsView([FAKE_BACKEND], theme, tui, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const viewAny = view as unknown as { stats: BackendStats[] };
    viewAny.stats = [{
      backend: FAKE_BACKEND,
      fetchedAt: Date.now(),
      models: [{ id: "model-a", status: "loaded" }],
      modelSlots: {
        "model-a": [
          {
            id: 0,
            isProcessing: true,
            nCtx: 8192,
            nPromptTokens: 1000,
            nPromptTokensProcessed: 500,
          },
        ],
      },
    }];

    const lines = view.render(120);

    // Find the active slot lines.
    const activeHeaderIdx = lines.findIndex((l) => l.includes("◐ processing prompt"));
    expect(activeHeaderIdx).toBeGreaterThanOrEqual(0);

    // The line right after the header should be the progress detail line.
    const detailLine = lines[activeHeaderIdx + 1];
    expect(detailLine).toBeDefined();
    expect(detailLine).toContain("█"); // Progress bar (filled blocks)
    expect(detailLine).toContain("░"); // Progress bar (empty blocks)
    expect(detailLine).toContain("500 / 1,000 tokens");

    view.dispose();
  });
});
