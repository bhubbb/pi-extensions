/**
 * Tests for StatsView lifecycle (cleanup, abort, timer).
 *
 * Does not test pixel-perfect rendering (behavior, not visuals).
 * Verifies: AbortController cleanup, timer disposal, render doesn't crash.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { StatsBackend } from "../src/config";
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
