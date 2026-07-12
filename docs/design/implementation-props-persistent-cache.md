# Implementation: persist `discoveredProps` to disk (per-server scope)

## Why we're doing this

After `/reload` (or any session restart), models default to `meta.n_ctx_train`
from `/v1/models` — or `DEFAULT_CONTEXT_WINDOW` (8192) if missing — until
`/props` is re-fetched. The `discoveredProps` cache lives in
`sessionState.discoveredProps` (in-memory only) and is cleared on
`session_shutdown`, which `/reload` triggers.

Result: the user sees the wrong context window after every reload, and has to
cycle through model select to force re-discovery. Worse, the "right" context
window was already discovered in the previous session — we just threw it away.

We want to:

1. **Persist `discoveredProps` across reloads** so the model shows the correct
   context immediately after `/reload`, not after a re-discovery round-trip.
2. **Scope the cache to each server**, not each model id alone. Two backends
   with different `baseUrl` could theoretically serve models with the same id
   but different configured `n_ctx`. The cache key must include something that
   uniquely identifies the server.
3. **Stay additive** — existing `pi-llama.json` files (without the new field)
   must continue to work without migration.

## Root cause

`sessionState.discoveredProps` is a `Map<string, { contextWindow; maxTokens;
supportsThinking }>` keyed by `${providerId}:${modelId}`. On `session_shutdown`
(line in `src/index.ts`) it is cleared alongside `failedProps`,
`pendingDiscovery`, and `sseManagers`.

The design doc for the error-handling work explicitly scoped the **negative**
cache (`failedProps`) to session-only. It did not explicitly require the
**positive** cache to be session-only, but the implementation followed the same
pattern. In hindsight that was over-cautious — the props don't change often
(server `n_ctx` is configured once), and the cost of a stale entry is bounded
by the re-probe on `session_start`.

## What already exists (do not rebuild)

- `sessionState.discoveredProps` — in-memory positive cache, populated in
  `applyPropsMetadata` and consumed in `discoverModelProps` (early-return when
  model is still loaded). Key: `${providerId}:${modelId}`.
- `PersistedConfig` in `src/types.ts` — the shape persisted to
  `~/.pi/agent/pi-llama.json`. Currently has `version` and `backends`.
- `loadPersistedConfig` / `savePersistedConfig` in `src/config.ts` — atomic
  load/save (read; or write to `.tmp` then rename).
- `resolveConfig()` — called once on extension load, returns the resolved
  backends. This is the natural place to seed the persistent cache.
- `session_start` handler — clears `failedProps`. We will additionally use it
  to trigger a re-probe of cached entries (to catch config changes).
- `applyPropsMetadata` — the single point where a successful discovery result
  lands. This is where we write to the persistent cache.

## What we're changing

### Change 1: add `discoveredProps` field to `PersistedConfig`

In `src/types.ts`, add an optional field:

```ts
export interface PersistedDiscoveredProps {
  /** Cache key (see Change 2). */
  key: string;
  contextWindow: number;
  maxTokens: number;
  supportsThinking: boolean;
  /** Unix ms timestamp of when this was discovered. */
  discoveredAt: number;
}

export interface PersistedConfig {
  version?: number;
  backends?: LlamaBackendConfig[];
  /** Map from cache key → discovered props. Additive; old files lack it. */
  discoveredProps?: Record<string, PersistedDiscoveredProps>;
}
```

The `Record<string, PersistedDiscoveredProps>` shape is chosen over an array
so we can use the cache key directly for O(1) lookup on load.

### Change 2: scope the cache key to the server

The current key is `${providerId}:${modelId}`. That has two problems for a
persistent cache:

1. **`providerId` is not stable** — it is `llama-cpp` in single-backend mode
   and `llama-cpp-N` in multi-backend mode. If the user switches between modes
   (e.g., removes a backend so `llama-cpp-1` becomes `llama-cpp`), all cache
   keys change and we'd lose the cached entries.
2. **Two backends could theoretically serve the same model id with different
   `n_ctx`** — e.g., a fast backend with `n_ctx=8192` and a slow backend with
   `n_ctx=131072`. The current key would collide.

Fix: change the persistent cache key to `${baseUrl}:${modelId}`. `baseUrl` is
the stable identifier for the server (it's set in the config and doesn't
change without the user editing it). Strip the trailing `/v1` and trailing
slash so equivalent URLs canonicalize to the same key.

```ts
function serverCacheKey(baseUrl: string, modelId: string): string {
  const normalized = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return `${normalized}:${modelId}`;
}
```

The in-memory `sessionState.discoveredProps` can keep its
`${providerId}:${modelId}` key — it doesn't need to survive reloads and the
existing dedup logic depends on it.

### Change 3: load the persistent cache on extension init

In `src/index.ts`, after `resolveConfig()` and `setCurrentConfig(config)`:

1. Read the persisted config (we already do this inside `resolveConfig` — we
   need to expose it, or re-read it).
2. For each entry in `persistedConfig.discoveredProps`, seed
   `sessionState.discoveredProps` using a mapping from `baseUrl → providerId`
   (built from the resolved backends).

The mapping is needed because the persistent key uses `baseUrl` but the
in-memory cache uses `providerId`. We translate at load time:

```ts
for (const [key, entry] of Object.entries(persistedConfig.discoveredProps ?? {})) {
  // Key format: `${normalizedBaseUrl}:${modelId}`
  // Find the backend whose normalizedBaseUrl matches.
  const match = config.find(
    (b) => normalizeBaseUrl(b.baseUrl) === key.split(":")[0]
  );
  if (!match) continue; // stale entry — backend removed
  const modelId = key.split(":").slice(1).join(":");
  const inMemoryKey = `${match.providerId}:${modelId}`;
  sessionState.discoveredProps.set(inMemoryKey, {
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    supportsThinking: entry.supportsThinking,
  });
}
```

Stale entries (backends that were removed) are silently dropped. They will be
garbage-collected on the next save.

### Change 4: write to the persistent cache on successful discovery

In `applyPropsMetadata`, after writing to `sessionState.discoveredProps`,
also write to the persisted config file:

1. Re-read the persisted config (to avoid clobbering concurrent changes).
2. Add/update the entry for this `${baseUrl}:${modelId}` key.
3. Save atomically via `savePersistedConfig`.

Writing on every discovery is fine because discovery only runs on user
actions (model select, before_provider_request) and the file is small. We
debounce only if profiling shows it matters.

```ts
function persistDiscoveredProps(
  baseUrl: string,
  modelId: string,
  props: { contextWindow: number; maxTokens: number; supportsThinking: boolean },
): void {
  // Fire-and-forget — failures are logged but don't block the request.
  void (async () => {
    try {
      const config = await loadPersistedConfig();
      const key = serverCacheKey(baseUrl, modelId);
      config.discoveredProps = {
        ...(config.discoveredProps ?? {}),
        [key]: {
          key,
          contextWindow: props.contextWindow,
          maxTokens: props.maxTokens,
          supportsThinking: props.supportsThinking,
          discoveredAt: Date.now(),
        },
      };
      await savePersistedConfig(config);
    } catch (err) {
      console.debug(
        `[llama-cpp] failed to persist discoveredProps for ${modelId}: ${(err as Error).message}`,
      );
    }
  })();
}
```

Call this from `applyPropsMetadata` right after
`sessionState.discoveredProps.set(key, props)`.

### Change 5: re-probe on `session_start` to catch config changes

The design doc for error handling clears `failedProps` on `session_start`. We
extend that to also kick off a re-probe of cached entries — to catch the case
where the server's `n_ctx` changed since the last discovery.

But we must not spam. Rules:

- **Only re-probe on `session_start`** (server reconnect), not on every
  `session_shutdown` → `session_start` cycle from `/reload`. Since
  `session_start` fires for both reloads and fresh starts, we need a way to
  distinguish. Practically: re-probe on every `session_start` is fine because
  the retry/cooldown logic in `discoverModelProps` will skip immediately if
  the cached entry is still valid and the model is loaded.
- **One re-probe per model per `session_start`**, using the existing
  `discoverModelProps` flow. It will hit the in-memory cache first (early
  return if model is still loaded), then fall through to `/props` if not.
- **The re-probe runs after the in-memory cache is seeded** (Change 3), so
  models that are still loaded will skip the network call entirely.

Concretely, in the `session_start` handler, after the existing
`sessionState.failedProps.clear()` and provider re-registration, iterate
over the seeded `discoveredProps` and call `discoverModelProps(autoload=false)`
for each. This is fire-and-forget.

```ts
for (const [inMemoryKey] of sessionState.discoveredProps) {
  const [providerId, modelId] = inMemoryKey.split(":");
  void discoverModelProps(pi, providerId, modelId, ctx, false);
}
```

The `discoverModelProps` retry/cooldown logic (Change 3 of the error-handling
work) handles transient failures gracefully. On `ok`, `applyPropsMetadata`
writes back to the persistent cache, refreshing `discoveredAt`.

### Change 6: drop stale entries on save

When saving `discoveredProps`, drop entries whose `baseUrl` no longer matches
any current backend. This prevents the file from accumulating dead entries
when a backend is removed.

```ts
function pruneStaleEntries(
  persisted: PersistedConfig,
  currentBackends: ResolvedBackend[],
): PersistedConfig {
  const validBaseUrls = new Set(
    currentBackends.map((b) => normalizeBaseUrl(b.baseUrl)),
  );
  const filtered: Record<string, PersistedDiscoveredProps> = {};
  for (const [key, entry] of Object.entries(persisted.discoveredProps ?? {})) {
    const baseUrl = key.split(":")[0];
    if (validBaseUrls.has(baseUrl)) {
      filtered[key] = entry;
    }
  }
  return { ...persisted, discoveredProps: filtered };
}
```

Call this in `persistDiscoveredProps` before saving.

## Files touched

- `packages/pi-llama/src/types.ts` — add `PersistedDiscoveredProps` type;
  extend `PersistedConfig` with `discoveredProps` field.
- `packages/pi-llama/src/config.ts` — add `serverCacheKey(baseUrl, modelId)`
  helper; update `savePersistedConfig` if needed (it already accepts the full
  `PersistedConfig`, so no signature change).
- `packages/pi-llama/src/index.ts` — seed `sessionState.discoveredProps` from
  the persisted config on init; add `persistDiscoveredProps` and `pruneStaleEntries`
  helpers; call them from `applyPropsMetadata` and `session_start`.
- `packages/pi-llama/src/discovery.ts` — no changes.
- `packages/pi-llama/src/sse.ts` — no changes.
- `packages/pi-llama/tests/discovery.test.ts` — add tests for the
  server-key derivation (`serverCacheKey` normalizes URLs), and a test that
  the persistent cache round-trips through `loadPersistedConfig` /
  `savePersistedConfig`.

No changes to `commands.ts`, `provider.ts`, or the extension entry point.

## Tests to add

In `tests/discovery.test.ts` (or a new `tests/cache.test.ts`):

- **`serverCacheKey` normalizes trailing `/v1`** — `http://x:8080/v1` and
  `http://x:8080/v1/` produce the same key.
- **`serverCacheKey` normalizes trailing slash** — `http://x:8080` and
  `http://x:8080/` produce the same key.
- **`serverCacheKey` distinguishes different `baseUrl`s** — same model id on
  different backends gets different keys.
- **`serverCacheKey` preserves model id with colons** — e.g.,
  `unsloth/Qwen:Q6_K` works (split on first `:` only).
- **Persistent cache round-trip** — write a config with `discoveredProps`,
  reload, assert the seeded `sessionState.discoveredProps` matches.
- **Stale entry pruning** — persisted entry whose `baseUrl` no longer matches
  any current backend is dropped on next save.
- **`session_start` re-probes cached entries** — after seeding, the handler
  triggers `discoverModelProps(autoload=false)` for each entry (mock fetch
  to assert call count).

Behavioral assertions only — no internal map shape checks.

## Tasks

- [ ] **types.ts**: add `PersistedDiscoveredProps`; extend `PersistedConfig`
  with `discoveredProps?: Record<string, PersistedDiscoveredProps>`.
- [ ] **config.ts**: add `serverCacheKey(baseUrl, modelId)` helper that
  normalizes trailing `/v1` and trailing slashes; splits on the first `:`
  after the normalized URL so model ids with `:` (quant suffixes) survive.
- [ ] **index.ts**: after `resolveConfig` / `setCurrentConfig`, seed
  `sessionState.discoveredProps` from `persistedConfig.discoveredProps` using
  a `baseUrl → providerId` mapping; drop entries for removed backends.
- [ ] **index.ts**: add `persistDiscoveredProps(baseUrl, modelId, props)`
  fire-and-forget helper that re-reads, updates, prunes, and saves the
  persisted config.
- [ ] **index.ts**: in `applyPropsMetadata`, call `persistDiscoveredProps`
  with the backend's `baseUrl` after writing to the in-memory cache.
- [ ] **index.ts**: in `session_start` handler, after seeding and clearing
  `failedProps`, iterate seeded `discoveredProps` and fire
  `discoverModelProps(autoload=false)` for each (re-probe to catch changes).
- [ ] **index.ts**: add `pruneStaleEntries(persisted, currentBackends)` and
  call it before saving.
- [ ] **tests**: `serverCacheKey` normalization tests (trailing `/v1`,
  trailing slash, quant-suffix model ids, different baseUrls).
- [ ] **tests**: persistent cache round-trip via `loadPersistedConfig` /
  `savePersistedConfig`.
- [ ] **tests**: stale entry pruning drops removed backends.
- [ ] **tests**: `session_start` triggers re-probe for seeded entries.
- [ ] `npm run typecheck` (or `tsc --noEmit`) passes.
- [ ] `bun test packages/pi-llama` — all pass.
- [ ] Manual: with a model whose `meta.n_ctx_train` is missing or 8192,
  `/reload` — the model shows the correct `contextWindow` from the cached
  props without needing to cycle through model select.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Stale cache after server `n_ctx` change | Re-probe on `session_start`; refresh `discoveredAt` on each successful discovery |
| File I/O contention if multiple pi instances run | `savePersistedConfig` is atomic (write to `.tmp` then rename); concurrent saves are last-write-wins but the data is idempotent |
| File grows unbounded if many models across many backends | Pruning on save drops removed backends; the per-entry size is small (~100 bytes) |
| Breaking existing `pi-llama.json` files | New field is optional; `loadPersistedConfig` already returns `{}` on any error; missing `discoveredProps` is treated as `undefined` |
| Re-probe on `/reload` causes server churn | Re-probes use `autoload=false` (no load forced); only succeed when model is already resident |

## Attribution

`pi-llama` is part of `bhubbb/pi-extensions` (EUPL-1.2). This change extends
the in-memory positive cache to survive reloads, building on the
classification/retry/notification work in
`implementation-props-error-handling.md`.
