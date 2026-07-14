/**
 * Fetch and parse llama.cpp server stats endpoints.
 *
 * Targets the **llama-app router** API (role: "router", models_autoload: true)
 * which requires `?model=<id>` on /slots. Falls back gracefully to classic
 * llama.cpp server endpoints.
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
  /** Error message if the backend is unreachable (set when /props and /health both fail). */
  error?: string;
  /** Parsed /props data. */
  props?: PropsStats;
  /** Per-model slots, keyed by model id (from /slots?model=<id>). */
  modelSlots?: Record<string, SlotStats[]>;
  /** Parsed /v1/models data. */
  models?: ModelStats[];
  /** Parsed /health data. */
  health?: { status: string };
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
  /** Router-level role (e.g. "router", "server"). */
  role?: string;
}

/** Per-slot status from /slots?model=<id>. */
export interface SlotStats {
  id: number;
  isProcessing: boolean;
  nCtx?: number;
  speculative?: boolean;
  // next_token is an array [{ n_decoded, n_remain, ... }] on the router API.
  nDecoded?: number;
  nRemain?: number;
  hasNextToken?: boolean;
  // Prompt token counts from params object.
  nPromptTokens?: number;
  nPromptTokensProcessed?: number;
  nPromptTokensCache?: number;
  // Timing fields — present in some builds, absent in others (defensive).
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
  nCtx?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
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
    role: typeof obj["role"] === "string" ? obj["role"] : undefined,
  };
}

/** Parse raw /slots array into SlotStats[]. Handles `next_token` as array (router) or object (classic). */
function parseSlots(raw: unknown, _modelId?: string): SlotStats[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((slot): SlotStats => {
    if (!slot || typeof slot !== "object") {
      return { id: -1, isProcessing: false };
    }
    const s = slot as Record<string, unknown>;

    // next_token is an array [{ n_decoded, n_remain, ... }] on the router API,
    // or a plain object on the classic API. Handle both defensively.
    let nDecoded: number | undefined;
    let nRemain: number | undefined;
    let hasNextToken: boolean | undefined;

    const nextToken = s["next_token"];
    if (Array.isArray(nextToken) && nextToken.length > 0) {
      // Router API: array of per-token snapshots.
      const first = nextToken[0] as Record<string, unknown> | undefined;
      nDecoded = Number(first?.["n_decoded"]) || undefined;
      nRemain = Number(first?.["n_remain"]) || undefined;
      hasNextToken = !!first?.["has_next_token"];
    } else if (nextToken && typeof nextToken === "object") {
      // Classic API: plain object.
      nDecoded = Number((nextToken as Record<string, unknown>)["n_decoded"]) || undefined;
      nRemain = Number((nextToken as Record<string, unknown>)["n_remain"]) || undefined;
    }

    // Prompt token counts from params object (present in router builds).
    const params = s["params"] && typeof s["params"] === "object"
      ? s["params"] as Record<string, unknown>
      : null;

    // Timing — defensive (present in some builds, absent in others).
    const timing =
      s["timing"] && typeof s["timing"] === "object"
        ? s["timing"] as Record<string, unknown>
        : null;

    return {
      id: Number(s["id"]) ?? -1,
      isProcessing: !!s["is_processing"],
      nCtx: Number(s["n_ctx"]) || undefined,
      speculative: !!s["speculative"],
      nDecoded,
      nRemain,
      hasNextToken,
      nPromptTokens: Number(params?.["n_prompt_tokens"]) || undefined,
      nPromptTokensProcessed: Number(params?.["n_prompt_tokens_processed"]) || undefined,
      nPromptTokensCache: Number(params?.["n_prompt_tokens_cache"]) || undefined,
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

    // Architecture info from meta (optional).
    let architecture: { input_modalities?: string[]; output_modalities?: string[] } | undefined;
    if (meta?.["architecture"] && typeof meta["architecture"] === "object") {
      const arch = meta["architecture"] as Record<string, unknown>;
      architecture = {
        input_modalities: Array.isArray(arch["input_modalities"]) ? arch["input_modalities"] as string[] : undefined,
        output_modalities: Array.isArray(arch["output_modalities"]) ? arch["output_modalities"] as string[] : undefined,
      };
    }

    return {
      id: typeof o["id"] === "string" ? o["id"] : "",
      status,
      nParams: Number(meta?.["n_params"]) || undefined,
      size: Number(meta?.["size"]) || undefined,
      nCtxTrain: Number(meta?.["n_ctx_train"]) || undefined,
      nCtx: Number(meta?.["n_ctx"]) || undefined,
      architecture,
    };
  });
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch all stats for a single backend.
 *
 * For llama-app router:
 *   1. Fetch /health, /props, /v1/models (no model param needed).
 *   2. For each loaded/loading model, fetch /slots?model=<id>.
 *
 * For classic llama.cpp server:
 *   1. Fetch /health, /props, /v1/models, /slots (no model param).
 *
 * Uses `Promise.allSettled` for core endpoints so a single failure doesn't block
 * the others. Per-model slots failures are caught individually.
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

  // Step 1: Fetch endpoints that don't require a model param.
  const [propsRaw, modelsRaw, healthRaw] = await Promise.allSettled([
    fetchJson(root + "/props", safeSignal, headers, fetchFn),
    fetchJson<{ data?: unknown[] }>(root + "/v1/models", safeSignal, headers, fetchFn),
    fetchJson<{ status?: string; error?: string }>(root + "/health", safeSignal, {}, fetchFn),
  ]);

  // Check reachability FIRST (before parsing):
  // - /v1/models failure means the backend is effectively unreachable for the
  //   stats view — we can't show any model data, so don't pretend it's alive.
  // - /health failure is the canonical liveness signal — the server isn't
  //   responding reliably.
  // - /props failure is tolerated (just means no build info) — other endpoints
  //   can still provide the data the view needs.
  const propsOk = propsRaw.status === "fulfilled" && propsRaw.value !== undefined;
  const modelsOk = modelsRaw.status === "fulfilled" && modelsRaw.value !== undefined;
  const healthOk = healthRaw.status === "fulfilled" && healthRaw.value !== undefined;
  const isUnreachable = !modelsOk || !healthOk;

  // Parse models first — needed to know which models to fetch slots for.
  const models = modelsRaw.status === "fulfilled" ? parseModels(modelsRaw.value) : undefined;
  const props = propsRaw.status === "fulfilled" && propsRaw.value ? parseProps(propsRaw.value) : undefined;

  // Parse health.
  const health = healthOk && healthRaw.value
    ? { status: (healthRaw.value.status ?? healthRaw.value.error ?? "unknown") as string }
    : undefined;

  let error: string | undefined;
  if (isUnreachable) {
    // Prefer /health error message since it's the primary unreachable signal.
    const healthRejection = healthRaw.status === "rejected" ? healthRaw : null;
    if (healthRejection?.reason?.message) {
      error = healthRejection.reason.message;
    } else {
      const firstRejection = [propsRaw, modelsRaw, healthRaw].find(
        (r) => r.status === "rejected",
      );
      if (firstRejection?.status === "rejected" && firstRejection.reason?.message) {
        error = firstRejection.reason.message;
      } else {
        error = "unreachable";
      }
    }
  }

  // Step 2: For each active model, fetch /slots?model=<id>.
  // Fetch slots for any model that isn't explicitly "unloaded" — the router
  // may use statuses like "loaded", "loading", "ready", "sleeping", etc.
  // Each per-model fetch is wrapped in .catch() so a single failure doesn't
  // discard data for other models.
  const activeModels = models?.filter(
    (m) => m.status !== "unloaded",
  ) ?? [];

  const modelSlotsArr = await Promise.all(
    activeModels.map((m) =>
      fetchJson(root + `/slots?model=${encodeURIComponent(m.id)}`, safeSignal, headers, fetchFn)
        .then((raw) => parseSlots(raw, m.id))
        .catch(() => []), // Per-model slots failure is non-fatal — return empty.
    ),
  );

  // Build keyed map: modelId → SlotStats[].
  const modelSlots: Record<string, SlotStats[]> = {};
  activeModels.forEach((m, i) => {
    modelSlots[m.id] = modelSlotsArr[i] ?? [];
  });

  // Fallback: if /v1/models failed entirely, try the classic /slots endpoint
  // (no model param) for backward compat with plain llama.cpp servers.
  let legacySlots: SlotStats[] | undefined;
  if (models === undefined && Object.keys(modelSlots).length === 0) {
    const slotsRaw = await fetchJson(root + "/slots", safeSignal, headers, fetchFn);
    if (slotsRaw) {
      legacySlots = parseSlots(slotsRaw);
    }
  }

  return {
    backend,
    error,
    props,
    modelSlots: Object.keys(modelSlots).length > 0
      ? modelSlots
      : legacySlots && legacySlots.length > 0
        ? { "": legacySlots }  // Legacy fallback — no model id available.
        : undefined,
    models,
    health,
    fetchedAt: Date.now(),
  };
}
