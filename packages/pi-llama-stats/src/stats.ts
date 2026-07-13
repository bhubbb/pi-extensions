/**
 * Fetch and parse llama.cpp server stats endpoints.
 *
 * Strictly decoupled from UI logic — all errors are returned as data, never thrown.
 * Accepts an optional `fetch` override for testing.
 */
import type { StatsBackend } from "./config";
import { authHeaders } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Build info, slots, models, health, and metrics for a single backend. */
export interface BackendStats {
  /** The backend this data belongs to. */
  backend: StatsBackend;
  /** Error message if the backend is unreachable (set when /props, /slots, and /health all fail). */
  error?: string;
  /** Parsed /props data. */
  props?: PropsStats;
  /** Parsed /slots data. */
  slots?: SlotStats[];
  /** Parsed /v1/models data. */
  models?: ModelStats[];
  /** Parsed /health data. */
  health?: { status: string };
  /** Parsed /metrics data (only present if the server has --metrics enabled). */
  metrics?: MetricsStats;
  /** Timestamp (ms) when this data was fetched. */
  fetchedAt: number;
}

/** Subset of /props fields the view cares about. */
export interface PropsStats {
  buildInfo?: string;
  modelPath?: string;
  totalSlots?: number;
  isSleeping?: boolean;
  nCtx?: number;
}

/** Per-slot status from /slots. */
export interface SlotStats {
  id: number;
  isProcessing: boolean;
  nCtx?: number;
  speculative?: boolean;
  nDecoded?: number;
  nRemain?: number;
  nPast?: number;
  nTokens?: number;
  truncated?: boolean;
  model?: string;
  predictedPerSecond?: number;
  promptPerSecond?: number;
}

/** Per-model info from /v1/models. */
export interface ModelStats {
  id: string;
  status?: string;
  nParams?: number;
  size?: number;
  nCtxTrain?: number;
}

/** Parsed Prometheus metrics from /metrics. */
export interface MetricsStats {
  promptTokensPerSecond?: number;
  predictedTokensPerSecond?: number;
  requestsProcessing?: number;
  requestsDeferred?: number;
  promptTokensTotal?: number;
  tokensPredictedTotal?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default fetch timeout (ms) — prevents hanging on unresponsive servers. */
const FETCH_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON endpoint with a timeout and abort signal.
 * Returns `undefined` on any error (network, timeout, non-200, malformed JSON).
 */
async function fetchJson<T>(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<T | undefined> {
  try {
    // Chain the parent signal with a per-fetch timeout so either can abort.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // Use AbortSignal.any if available (Node 17+), else fall back to parent-only.
    const combined = typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, controller.signal])
      : signal;

    const res = await fetchFn(url, {
      headers: { "Content-Type": "application/json", ...headers },
      signal: combined,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    // Network error, timeout, abort, or malformed JSON — all return undefined.
    return undefined;
  }
}

/**
 * Fetch a text endpoint with a timeout and abort signal.
 * Returns `undefined` on any error.
 */
async function fetchText(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const combined = typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, controller.signal])
      : signal;

    const res = await fetchFn(url, {
      headers,
      signal: combined,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse raw /props JSON into PropsStats. */
function parseProps(raw: unknown): PropsStats | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    buildInfo: typeof obj["build_info"] === "string" ? obj["build_info"] : undefined,
    modelPath: typeof obj["model_path"] === "string" ? obj["model_path"] : undefined,
    totalSlots: Number(obj["total_slots"]) || undefined,
    isSleeping: !!obj["is_sleeping"],
    nCtx:
      obj["default_generation_settings"] &&
      typeof obj["default_generation_settings"] === "object"
        ? (Number((obj["default_generation_settings"] as Record<string, unknown>)["n_ctx"]) || undefined)
        : undefined,
  };
}

/** Parse raw /slots array into SlotStats[]. */
function parseSlots(raw: unknown): SlotStats[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((slot): SlotStats => {
    if (!slot || typeof slot !== "object") {
      return { id: -1, isProcessing: false };
    }
    const s = slot as Record<string, unknown>;
    const timing =
      s["timing"] && typeof s["timing"] === "object"
        ? s["timing"] as Record<string, unknown>
        : null;
    return {
      id: Number(s["id"]) ?? -1,
      isProcessing: !!s["is_processing"],
      nCtx: Number(s["n_ctx"]) || undefined,
      speculative: !!s["speculative"],
      nDecoded: Number(s["next_token"] && (s["next_token"] as Record<string, unknown>)["n_decoded"]) || undefined,
      nRemain: Number(s["next_token"] && (s["next_token"] as Record<string, unknown>)["n_remain"]) || undefined,
      nPast: Number(s["n_past"]) || undefined,
      nTokens: Number(s["n_tokens"]) || undefined,
      truncated: !!s["truncated"],
      model: typeof s["model"] === "string" ? s["model"] : undefined,
      predictedPerSecond: Number(timing?.["predicted_per_second"]) || undefined,
      promptPerSecond: Number(timing?.["prompt_per_second"]) || undefined,
    };
  });
}

/** Parse raw /v1/models response into ModelStats[]. */
function parseModels(raw: unknown): ModelStats[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { data?: unknown[] };
  if (!Array.isArray(obj.data)) return [];
  return obj.data.map((m): ModelStats => {
    if (!m || typeof m !== "object") return { id: "" };
    const o = m as Record<string, unknown>;
    const meta =
      o["meta"] && typeof o["meta"] === "object"
        ? o["meta"] as Record<string, unknown>
        : null;
    const statusObj = o["status"];
    const status: string | undefined =
      statusObj && typeof statusObj === "object"
        ? (typeof (statusObj as Record<string, unknown>)["value"] === "string"
            ? ((statusObj as Record<string, unknown>)["value"] as string)
            : undefined)
        : typeof statusObj === "string"
          ? statusObj
          : undefined;
    return {
      id: typeof o["id"] === "string" ? o["id"] : "",
      status,
      nParams: Number(meta?.["n_params"]) || undefined,
      size: Number(meta?.["size"]) || undefined,
      nCtxTrain: Number(meta?.["n_ctx_train"]) || undefined,
    };
  });
}

/**
 * Parse Prometheus text format from /metrics.
 *
 * Lines look like: `llamacpp:predicted_tokens_seconds 52.94`
 * Extracts the first match per named gauge/counter.
 */
export function parseMetricsText(text: string): MetricsStats {
  const result: MetricsStats = {};
  const lines = text.split("\n");

  const metricMap: Record<string, keyof MetricsStats> = {
    "llamacpp:prompt_tokens_seconds": "promptTokensPerSecond",
    "llamacpp:predicted_tokens_seconds": "predictedTokensPerSecond",
    "llamacpp:requests_processing": "requestsProcessing",
    "llamacpp:requests_deferred": "requestsDeferred",
    "llamacpp:prompt_tokens_total": "promptTokensTotal",
    "llamacpp:tokens_predicted_total": "tokensPredictedTotal",
  };

  for (const line of lines) {
    for (const [name, key] of Object.entries(metricMap)) {
      if (line.startsWith(name + " ")) {
        const value = parseFloat(line.slice(name.length + 1));
        if (!isNaN(value)) {
          result[key] = value;
        }
        break; // One metric per line — move to next line
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch all stats for a single backend in parallel.
 *
 * Uses `Promise.allSettled` so a single endpoint failure (e.g. /metrics 501)
 * does not block the others. Sets `error` only if /props, /slots, and /health
 * all fail (treat as unreachable).
 *
 * @param signal - Parent abort signal (from the view's AbortController). Passed
 *                 through to all sub-fetches so closing the view aborts everything.
 * @param fetchFn - Optional fetch override for testing.
 */
export async function fetchBackendStats(
  backend: StatsBackend,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<BackendStats> {
  const headers = authHeaders(backend);
  const root = backend.rootUrl;

  // Create a no-op signal if none provided (ensures fetchJson always has one).
  const safeSignal = signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);

  // Fetch all endpoints in parallel.
  const [propsRaw, slotsRaw, modelsRaw, healthRaw, metricsRaw] = await Promise.allSettled([
    fetchJson(root + "/props", safeSignal, headers, fetchFn),
    fetchJson(root + "/slots", safeSignal, headers, fetchFn),
    fetchJson<{ data?: unknown[] }>(root + "/v1/models", safeSignal, headers, fetchFn),
    fetchJson<{ status?: string; error?: string }>(root + "/health", safeSignal, {}, fetchFn), // /health is public (no auth)
    fetchText(root + "/metrics", safeSignal, headers, fetchFn),
  ]);

  // Check which core endpoints failed.
  const propsOk = propsRaw.status === "fulfilled" && propsRaw.value !== undefined;
  const slotsOk = slotsRaw.status === "fulfilled" && slotsRaw.value !== undefined;
  const healthOk = healthRaw.status === "fulfilled" && healthRaw.value !== undefined;

  // Determine unreachable status: all three core endpoints failed.
  const isUnreachable = !propsOk && !slotsOk && !healthOk;

  // Build error message if unreachable.
  let error: string | undefined;
  if (isUnreachable) {
    // Try to extract a meaningful error from the first rejected promise.
    const firstRejection = [propsRaw, slotsRaw, healthRaw].find(
      (r) => r.status === "rejected",
    );
    if (firstRejection?.status === "rejected" && firstRejection.reason?.message) {
      error = firstRejection.reason.message;
    } else {
      error = "unreachable";
    }
  }

  // Parse successfully fetched data.
  const props = propsOk ? parseProps(propsRaw.value) : undefined;
  const slots = slotsOk ? parseSlots(slotsRaw.value) : undefined;
  const models = modelsRaw.status === "fulfilled" ? parseModels(modelsRaw.value) : undefined;
  const health =
    healthOk && healthRaw.value
      ? { status: (healthRaw.value.status ?? healthRaw.value.error ?? "unknown") as string }
      : undefined;

  // Parse metrics (text format) only if fetch succeeded and returned content.
  let metrics: MetricsStats | undefined;
  if (metricsRaw.status === "fulfilled" && metricsRaw.value) {
    metrics = parseMetricsText(metricsRaw.value);
  }

  return {
    backend,
    error,
    props,
    slots,
    models,
    health,
    metrics,
    fetchedAt: Date.now(),
  };
}
