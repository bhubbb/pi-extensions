# Implementation v2: pi-llama-stats — revised for llama-app router API

## What broke

The original design targeted the classic llama.cpp server API. The user's server
is the **llama-app router** (`role: "router"`, `models_autoload: true`) which has
a different endpoint shape:

| Endpoint | Original assumption | Actual behavior (llama-app router) |
|---|---|---|
| `GET /slots` | Returns all slots | **400** — requires `?model=<modelId>` query param |
| `GET /props` | Per-server build info | Router-level props (`role: "router"`, `build_info`) |
| `GET /metrics` | Prometheus text (if `--metrics`) | **400** — requires `?model=<modelId>` |
| `GET /v1/models` | `data[]` with `id`, `status`, `meta` | ✅ Same shape — works |
| `GET /health` | `{"status":"ok"}` | ✅ Same — works |

Additionally:
- `next_token` in `/slots` is an **array** `[{ n_decoded, n_remain, ... }]` not an object
- `timing.predicted_per_second` and `timing.prompt_per_second` are **not present** in
  the slots response for this server build (no per-slot tok/s exposed)
- `params` object is present inside each slot (contains generation params,
  `n_prompt_tokens`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache`)

## Revised fetch flow

```
press Ctrl+Shift+L
  ├─ resolve backends
  ├─ for each backend:
  │   ├─ fetch /health (public, no model) → ok/unreachable
  │   ├─ fetch /props (router-level) → build_info
  │   ├─ fetch /v1/models → data[] with model ids + status
  │   └─ for each model in data[]:
  │       └─ fetch /slots?model=<id> → slots for that model
  ├─ render()
  └─ 2s refresh → repeat
```

**Consequence:** more fetches per backend (one per model for slots). With
`AbortSignal` and 3s per-fetch timeout, this is acceptable. The in-flight
guard prevents stacking.

## Revised types

### `SlotStats`

```typescript
interface SlotStats {
  id: number;
  isProcessing: boolean;
  nCtx?: number;
  speculative?: boolean;
  // next_token is an array of per-token snapshots
  nDecoded?: number;    // from next_token[0]?.n_decoded
  nRemain?: number;     // from next_token[0]?.n_remain
  hasNextToken?: boolean;
  nPromptTokens?: number;
  nPromptTokensProcessed?: number;
  nPromptTokensCache?: number;
  // Timing fields — present in some builds, absent in others (defensive)
  predictedPerSecond?: number;
  promptPerSecond?: number;
}
```

### `ModelStats` — add `nCtx` field (was `n_ctx_train`, now also `n_ctx`)

```typescript
interface ModelStats {
  id: string;
  status?: string;           // "loaded" | "unloaded" | "loading" | "sleeping"
  nParams?: number;
  size?: number;
  nCtxTrain?: number;
  nCtx?: number;             // from meta.n_ctx
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}
```

### `BackendStats` — add router-level info

```typescript
interface BackendStats {
  backend: StatsBackend;
  error?: string;
  props?: PropsStats;
  // New: per-model slots (keyed by model id)
  modelSlots?: Record<string, SlotStats[]>;
  models?: ModelStats[];
  health?: { status: string };
  metrics?: MetricsStats;    // dropped (not useful without --metrics + model param)
  fetchedAt: number;
}
```

## Revised parse helpers

### `parseSlots(raw)` — handle array `next_token`

```typescript
function parseSlots(raw: unknown, modelId?: string): SlotStats[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((slot): SlotStats => {
    if (!slot || typeof slot !== "object") return { id: -1, isProcessing: false };
    const s = slot as Record<string, unknown>;

    // next_token is now an array [{ n_decoded, n_remain, ... }]
    const nextTokenArr = Array.isArray(s["next_token"]) ? s["next_token"] : [];
    const firstToken = nextTokenArr[0] as Record<string, unknown> | undefined;

    return {
      id: Number(s["id"]) ?? -1,
      isProcessing: !!s["is_processing"],
      nCtx: Number(s["n_ctx"]) || undefined,
      speculative: !!s["speculative"],
      nDecoded: Number(firstToken?.["n_decoded"]) || undefined,
      nRemain: Number(firstToken?.["n_remain"]) || undefined,
      hasNextToken: !!firstToken?.["has_next_token"],
      nPromptTokens: Number(s["n_prompt_tokens"]) || undefined,
      nPromptTokensProcessed: Number(s["n_prompt_tokens_processed"]) || undefined,
      nPromptTokensCache: Number(s["n_prompt_tokens_cache"]) || undefined,
      // Timing — defensive (present in some builds)
      predictedPerSecond: Number(s["timing"]?.["predicted_per_second"]) || undefined,
      promptPerSecond: Number(s["timing"]?.["prompt_per_second"]) || undefined,
    };
  });
}
```

## Revised `fetchBackendStats`

```typescript
async function fetchBackendStats(
  backend: StatsBackend,
  signal?: AbortSignal,
  fetchFn?: typeof fetch,
): Promise<BackendStats> {
  // 1. Fetch router-level endpoints (no model needed).
  const [propsRaw, modelsRaw, healthRaw] = await Promise.allSettled([
    fetchJson(backend.rootUrl + "/props", signal, headers),
    fetchJson<{ data?: unknown[] }>(backend.rootUrl + "/v1/models", signal, headers),
    fetchJson(backend.rootUrl + "/health", signal, {}),
  ]);

  const models = parseModels(modelsRaw);

  // 2. For each **loaded** model, fetch /slots?model=<id>.
  // Skip unloaded/sleeping models — they have no active slots, and polling
  // every model on every tick causes unnecessary network noise.
  const activeModels = models?.filter((m) => m.status === "loaded" || m.status === "loading") ?? [];
  const modelSlotsPromises = activeModels.map((m) =>
    fetchJson(backend.rootUrl + `/slots?model=${encodeURIComponent(m.id)}`, signal, headers)
      .then((raw) => parseSlots(raw, m.id))
      .catch(() => []), // Per-model slots failure is non-fatal.
  );

  const modelSlotsArr = await Promise.all(modelSlotsPromises);

  // 3. Build keyed map: modelId → SlotStats[].
  // Only active models have slots; unloaded models get an empty array in the render.
  const modelSlots: Record<string, SlotStats[]> = {};
  activeModels.forEach((m, i) => { modelSlots[m.id] = modelSlotsArr[i] ?? []; });

  // ... assemble BackendStats ...
}
```

## Revised render layout

```
╭─ llama.cpp stats ──────────── r refresh · q close ─╮
│ [llama-cpp-0] http://localhost:8080   build b9870-2d973636e  │
│   health: ok                                            │
│                                                         │
│   models:                                               │
│     unsloth/Qwen3.6-27B-MTP-GGUF:Q6_K_XL   loaded   27.3B params  26.0 GB
│       slots:                                            │
│         #0  idle  ctx 131072  spec: yes
│         #1  idle  ctx 131072  spec: yes
│         #2  idle  ctx 131072  spec: yes
│         #3  idle  ctx 131072  spec: yes  decoded 154  remain 18405  prompt 106376/1684
│                                                         │
│     unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q8_K_XL   unloaded
╰─────────────────────────────────────────────────────╯
```

- Model lines show id, status, params, size (same as before)
- Slots are nested under each model (not flat)
- Slot line shows: `#N  status  ctx N  spec: yes/no` + processing details
- When a slot is processing: add `decoded N  remain N  prompt X/Y`
- Timing tok/s shown when present (most router builds don't expose it)
- Unloaded models still listed (with no slots section)

## Changes required

### `src/stats.ts`
- `fetchBackendStats`: fetch `/v1/models` first, then `/slots?model=<id>` per model
- `parseSlots`: handle `next_token` as array, add `nPromptTokens*` fields
- `parseModels`: add `nCtx` and `architecture` fields
- Drop `/metrics` fetch (requires model param, not worth the extra requests)
- Update `BackendStats` type to use `modelSlots: Record<string, SlotStats[]>`

### `src/view.ts`
- `renderBackend`: iterate `stat.models`, render slots under each model
- `renderSlot`: show prompt tokens processed/cache when present
- Update slot line format for nested layout
- **Overflow:** existing `scrollOffset` slicing handles overflow. The view
  renders all lines then slices — no change needed to the scroll mechanism.
  Each model block is self-contained (blank line separator).

### `tests/stats.test.ts`
- Update mock responses to match new API shape (`next_token` array, model param)
- Add test for `/slots?model=<id>` fetch path
- Add test for per-model slots keyed map
- **Partial failure:** `/v1/models` returns 3 models, but one `/slots` call returns 400/500 — the other 2 models should still render with their slots
- **Empty set:** `/v1/models` returns no models — should render without crashing
- **Slow response / timeout:** One model's `/slots` call hangs — verify `AbortSignal` timeout rejects per-request without blocking other requests
- **In-flight guard:** Verify a second refresh cycle cannot start while the first is still fetching (hard lock via boolean flag or promise chain)

## Resilience requirements (reviewer-mandated)

1. **Strict error isolation:** The per-model `/slots?model=<id>` loop must have a `try-catch` (or `.catch()`) *inside* the loop. A failure for one model must not discard data for other models, nor block rendering of `/props` and `/v1/models` data. (Already implemented as `.catch(() => [])` in the pseudocode above.)

2. **In-flight guard (hard lock):** A boolean flag or promise chain prevents a new refresh cycle from starting while the previous one is still fetching. With multiple backends × multiple models, the 2s refresh is aggressive — the guard must be absolute, not advisory.

3. **Per-request `AbortSignal`:** Each `/slots?model=<id>` fetch gets its own timeout (3s). A hanging request on one model must not delay the entire render cycle.

## What does NOT change
- `src/config.ts` — unchanged
- `src/index.ts` — unchanged
- Package layout, shortcut, command — unchanged
- AbortController lifecycle, recursive setTimeout — unchanged
- Read-only scope — unchanged
