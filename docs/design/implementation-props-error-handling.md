# Implementation: pi-llama `/props` error handling

## Why we're doing this

Users see a opaque, repeated warning:

    [llama-cpp] /props for unsloth/gemma-4-31B-it-qat-GGUF:Q4_K_XL returned 400

This warning is fired from `packages/pi-llama/src/discovery.ts` inside
`fetchModelProps` whenever the llama.cpp server returns any non-OK status
(except a `500` during `autoload`, which is already silenced). The
message gives no clue *why* it failed, whether the model is still usable,
or what the user should do. Worse, the same warning can repeat on **every
single completion request** because `before_provider_request` re-probes
`/props` with `autoload=false` on each turn.

We want error handling that:

1. **Explains the real reason** by reading the server's JSON error body
   instead of just the status code.
2. **Distinguishes benign probes from real failures** — a metadata probe
   against a not-yet-loaded model is normal, not an error.
3. **Retries transient failures** — `/props` *should* be there, so a
   `400 not-loaded`, `400 not-found`, or `5xx` during a load/reload is
   usually transient and recovers with a short retry. Retry must be
   bounded (no hammering) and must respect who called (autoload flag)
   so a probe that deliberately won't autoload doesn't loop forever.
4. **Stops spamming** — once a model is known-bad for this session,
   skip the network call entirely instead of re-probing on every
   request. Re-probe only when state changes (server reconnect, model
   loaded, user re-selects).
5. **Keeps the model usable** — a `/props` failure only means we could
   not discover `n_ctx` / thinking support; the model should keep working
   with fallback defaults and the user should be told that clearly.

**Critical constraint:** `/props` is purely a metadata discovery
optimization. It must never block a completion, never churn server loads,
and never downgrade a working model. All changes are additive to the
discovery path; the offline-fallback and live-discovery registration
paths are untouched.

## Root cause (from llama.cpp source)

The llama.cpp **router mode** server (`tools/server/server-models.cpp`)
handles `GET /props?model=<id>&autoload=<bool>` like this:

- If `model` is empty → returns a dummy "router" props object (no error).
- Otherwise it calls `router_validate_model(name, models, autoload, ...)`,
  which returns `400` with `ERROR_TYPE_INVALID_REQUEST` in three cases:
  1. **`model name is missing from the request`** — `name` is empty
     (cannot happen from our code; we always send `model`).
  2. **`model '<id>' not found`** — `models.get_meta(name)` found no
     model **and no alias** with that id. The model id we send is not
     recognized by the router's model map.
  3. **`model is not loaded`** — `autoload=false` **and** the model is
     not currently running (`!meta->is_running()`). This is the benign
     probe case.

All three return HTTP `400` with a JSON body shaped like
`{ "error": { "code": 400, "message": "...", "type": "invalid_request" } }`.
Our code currently ignores the body entirely and only logs the status.

The error in the bug report is **case 3** in the common path: the
`before_provider_request` handler calls `discoverModelProps(..., false)`
(autoload=false) on every request. If the model is not currently loaded
on the server (selected but evicted by LRU, sleeping, or never loaded),
`/props` returns `400 "model is not loaded"`. We log it as a generic
warning on every turn → spam. Case 2 (`model not found`) is the rarer but
real "the id does not match the server's map" case and needs an
actionable message.

Note: the model id returned by `GET /v1/models` is the router's
`meta.name` (e.g. `unsloth/gemma-4-31B-it-qat-GGUF:Q4_K_XL`), and `/props`
looks up the same map by the same key. So the id *should* round-trip.
Case 2 therefore points at a genuine mismatch (alias vs canonical name,
id mutated between listing and probe, or an old/non-router server that
does not understand the id format) — not at our URL encoding. The design
must still verify the id round-trips exactly (see Tasks), but the primary
fix is error classification + noise reduction, not URL rewriting.

## What already exists (do not rebuild)

- `fetchModelProps` in `src/discovery.ts` — already returns `undefined`
  on any non-OK, already silences `500` during `autoload`, already has a
  `PROPS_TIMEOUT_MS` (120s) abort, and already swallows abort / "stale
  after session replacement" errors. Keep this structure; extend the
  non-OK branch and the return type.
- `discoverModelProps` in `src/index.ts` — already dedupes concurrent
  probes via `sessionState.pendingDiscovery` (a `Set<string>`), already
  caches positive results in `sessionState.discoveredProps`, and already
  applies cached metadata when a model is still loaded. It has access to
  `ctx` (so it can call `ctx.ui.notify`) on the `model_select` and
  `before_provider_request` paths. Keep the caching/dedup; add a
  negative-result cache and classification-driven notifications.
- The `500`-during-autoload silencing is the **template** for the new
  "benign probe" silencing: a single `if` guards an expected status, and
  the function returns `undefined` quietly. Reuse that pattern.
- `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` in `src/constants.ts`
  are the pre-discovery fallbacks. A `/props` failure leaves these in
  place — the model stays usable. Do not change these constants.

## What we're changing

### Change 1: read and parse the error body in `fetchModelProps`

Before logging or returning, when `!response.ok`, read
`await response.json()` (guarded by try/catch — the body may be empty or
non-JSON on proxies like llama-swap). Extract `error.message` and
`error.type` from the standard llama.cpp error envelope. This is the
single most important change: it turns a bare `400` into a known reason.

### Change 2: classify the non-OK outcome into a typed result

Replace the boolean-ish `undefined`-or-value return of `fetchModelProps`
with a typed result object so callers can react per-case. The result
variants (names are descriptive, pick reasonable identifiers when
implementing). Each variant carries a **`retryable`** hint so the caller
knows whether to retry:

- **`ok`** — props discovered; carries `contextWindow`, `maxTokens`,
  `supportsThinking` (same fields as today). `retryable: false`.
- **`not-loaded`** — body says `model is not loaded` (status `400` +
  that message). **`retryable: true`.** Benign outcome, but often
  transient — the server may be mid-load, or another request just
  unloaded the model. Caller must **not** warn on each probe (the model
  is fine, we just couldn't read metadata while it's not resident).
- **`not-found`** — body says `model '<id>' not found` (or `model is not
  found`). **`retryable: true` with a low budget.** Usually means the id
  isn't in the server's map, but can race during server startup or a
  concurrent model swap. Caller surfaces an actionable notification
  once after the budget is spent.
- **`endpoint-missing`** — status `404` with no parseable llama.cpp
  error body (old build, or a proxy like llama-swap that does not expose
  `/props`). **`retryable: false`.** The endpoint is genuinely absent;
  retrying won't help. Silent skip after one info-level message.
- **`server-error`** — `500` (outside the already-silenced autoload
  case), `502`, `503`, `504`. **`retryable: true`.** Transient. The
  existing `autoload && 500` silencing stays as a quiet-success on the
  autoload=true path (the server cancels a load to start another — the
  caller's `discoverModelProps` will retry and the next attempt will
  see the freshly loaded model).
- **`error`** — anything else (network, abort already handled today;
  keep that behavior). **`retryable: true` for network, `false` for
  abort.** Caller decides.

The classification must inspect the body before deciding `retryable` —
a `400` with `model is not loaded` is transient, but a bare `400` with
no parseable body falls back to `error` and is treated as transient by
default (since `/props` *should* exist, a bare 400 is unusual enough
that a retry is cheaper than giving up).

### Change 3: retry transient failures with bounded backoff

`fetchModelProps` stays a **single-attempt** function (pure, testable,
no timer state). The caller `discoverModelProps` owns retry and backoff
because it knows the autoload flag and call site.

**Retry policy** (lives in `discoverModelProps`):

- Retry only variants marked `retryable: true` (`not-loaded`,
  `not-found`, `server-error`, `error` from network). Never retry
  `endpoint-missing`.
- **Bounded attempt counts** per call, controlled by constants
  (Change 8):
  - `not-loaded`: retry up to `PROPS_NOT_LOADED_MAX_ATTEMPTS` (e.g. 3)
    with delays `500ms`, `1s`, `2s`. On `before_provider_request`
    (autoload=false), cap at the **same** count but bail out earlier if
    the model isn't loaded per `ModelLoadTracker` — retrying a probe
    that deliberately won't autoload won't help and just delays the
    next request.
  - `not-found`: retry up to `PROPS_NOT_FOUND_MAX_ATTEMPTS` (e.g. 2)
    with delays `500ms`, `1s`. Covers server-startup races.
  - `server-error` / network `error`: retry up to
    `PROPS_SERVER_ERROR_MAX_ATTEMPTS` (e.g. 3) with delays `1s`, `2s`,
    `4s` (full jitter to avoid synchronized retries).
  - On `model_select` (autoload=true, awaited), retry `not-loaded`
    more aggressively (`PROPS_AUTOLOAD_MAX_ATTEMPTS`, e.g. 5) with
    longer delays (`1s`, `2s`, `4s`, `8s`, `15s`) because the server is
    actively loading and the call is awaited — the user is waiting for
    selection to finish.
- **Per-attempt timeout** (not the full 120s `PROPS_TIMEOUT_MS`): each
  `fetchModelProps` call uses a shorter `PROPS_ATTEMPT_TIMEOUT_MS`
  (e.g. 15s) so a stuck request doesn't burn the whole retry budget.
  The overall ceiling stays generous (sum of delays + attempts ≈
  30–60s worst case), well under the 120s the current code already
  allows.
- **Abort the retry loop early** if the abort signal fires (session
  replacement, shutdown) — same `stale after session replacement`
  guard already in place.
- **Treat retry success as `ok`**: once any attempt returns `ok`,
  clear any prior `failedProps` entry (see Change 4) and apply the
  discovered metadata as today.

### Change 4: add a per-model negative-result cache (retry-aware)

`sessionState.pendingDiscovery` only prevents **concurrent** duplicates.
It does not prevent the same model from failing `/props` on every new
request, and it does not coordinate with retry. Add a
`sessionState.failedProps` map keyed by `${providerId}:${modelId}`,
storing the last classification plus a **cooldown timestamp** (next
allowed probe time) and a **give-up flag**.

**Cache semantics** (must be coordinated with Change 3's retry loop):

- **Before probing** (`discoverModelProps` entry), check the cache:
  - If `giveUp === true` for an unrecoverable variant (`endpoint-missing`,
    or `not-found` after retry budget exhausted) → skip the network
    entirely, keep fallback metadata, no warn, no notify.
  - If `giveUp === false` but `cooldown > now` (we recently failed and
    are inside the cooldown window) → skip until cooldown expires.
    This caps the probe rate for transient variants without dropping
    the model.
  - If the cache says the model is currently loaded per
    `ModelLoadTracker` but we still have a `not-loaded` failure cached
    → treat as stale and retry (see reconnect handling below).
- **On retry loop success** (`ok` from any attempt) → delete the cache
  entry entirely.
- **On retry loop exhaustion** → write the cache entry with
  `giveUp: true` for `not-found` and `endpoint-missing`; write
  `giveUp: false` with a short cooldown (e.g. 5s) for `not-loaded`
  and `server-error`, so we keep trying as conditions change.
- **Cooldown schedule** (configurable, see Change 8):
  - `not-loaded`: 5s — short, because the model may load any moment.
  - `server-error`: 30s — longer, server is struggling, don't hammer.
  - Network `error`: 10s.
  - On the `before_provider_request` probe path, double these to
    reduce per-request noise.
- **Reconnect / state-change clears** (this is the robustness half):
  - `model_select` handler: clear the cache entry for the selected
    model — user explicitly chose it, autoload=true will be tried.
  - `session_start` handler: clear `failedProps` for every backend —
    the server may have restarted, models reloaded, or the URL may
    point at a freshly-started server.
  - SSE `loaded` event for a model (`onLoaded` in `SseManager`): clear
    the cache entry for that `providerId:modelId` — the model is now
    resident, so a prior `not-loaded` is stale; re-probe on the next
    applicable event.
  - `session_shutdown` handler: clear all `failedProps` (already
    alongside the other `sessionState` clears).

Keep the cache **session-scoped** (no disk persistence) — a fresh
session always gets a clean slate.

### Change 5: surface actionable user notifications (only for real problems)

`fetchModelProps` must stay a pure function with no `ctx`. It returns the
typed result; the **caller** (`discoverModelProps`) decides on
notifications because it has `ctx`. Notification rules — applied **after**
the retry loop (Change 3) settles, so a transient blip never notifies:

- `not-loaded` → never notify, even after retries (see Change 3).
- `endpoint-missing` → one-time `info`-level notification per backend
  per session: "llama.cpp /props unavailable on <backend>; using default
  context window". Do not repeat.
- `not-found` (after the retry budget is spent) → one `warning`
  notification: "model <id> not found on server <providerId> after
  retries; metadata discovery skipped. Model still usable with default
  context window. Check `/llama-status`." Do not repeat per request
  (Change 4 prevents re-probing and marks `giveUp`). Suggest the user
  verify the model id matches `GET /v1/models` and that they are not
  pointing at an old/non-router build.
- `server-error` (after the retry budget is spent) → at most one
  `warning` per model per session: "llama.cpp /props for <id> failed
  (<status>) after retries; using default metadata. Will retry again
  after cooldown."
- `error` (network etc. after retries) → keep the existing single-line
  `console.warn`; do **not** spam `ctx.ui.notify` (these are usually
  transient/abort).

Every user-facing message must state that **the model remains usable**
with fallback defaults, so users do not think the model is broken. The
cooldown in Change 4 means a `server-error` notification can recur at
most once per cooldown window if the server keeps failing — that is
acceptable, it signals a real problem worth re-surfacing.

### Change 6: verify the model id round-trips (sanity, not a rewrite)

Add a one-time debug check (not user-facing) that the id we send to
`/props` decodes back to exactly the id we got from `/v1/models`. Concretely:
`encodeURIComponent(modelId)` must `decodeURIComponent` back to `modelId`,
and the encoded form must not contain a double-encoded `%`. This is a
cheap assertion/log, not a URL-building change — the router uses the same
map key for both endpoints, so the id is expected to match. If a `not-found`
case is observed in testing, this check is the first diagnostic to look at.
Do **not** add speculative id-normalization (e.g. stripping a `:Q4_K_XL`
quant suffix) unless this check proves the id is being mutated — that would
break models whose canonical name genuinely includes the suffix.

### Change 7: keep `model_select` autoload=true behavior intact, with retry + cache clear

`model_select` calls `discoverModelProps(..., true)` so selecting a model
loads it. With autoload=true, the server will not return `not-loaded`
during a normal load — it triggers `ensure_model_ready` which can race
with another load and may return `500` (already silenced today). Changes
on this path:

- **Clear the `failedProps` entry for the selected model at the start
  of `discoverModelProps`** when called from `model_select`. The user
  explicitly chose this model; give it a fresh chance with
  autoload=true regardless of prior failures. (The reconnect-handling
  half lives in Change 4.)
- **Use the longer autoload retry budget** from Change 3
  (`PROPS_AUTOLOAD_MAX_ATTEMPTS`) — the call is awaited and the user
  is waiting on selection, so more aggressive retry is worth it.
- The existing `autoload && 500` silencing stays in `fetchModelProps`;
  the retry loop in `discoverModelProps` will simply retry, and once
  the load completes the next attempt returns `ok`.

### Change 8: add retry / cooldown / per-attempt-timeout constants

`PROPS_TIMEOUT_MS = 120_000` today is used as the per-call abort
deadline. For retry, each attempt should use a shorter deadline so a
stuck request can't burn the whole retry budget; the overall ceiling
stays generous. Add to `constants.ts`:

- `PROPS_ATTEMPT_TIMEOUT_MS = 15_000` — per-attempt abort. Each
  `fetchModelProps` call uses this (overridable via the existing
  `timeoutMs` param for tests).
- `PROPS_NOT_LOADED_MAX_ATTEMPTS = 3` — attempts for `not-loaded`.
- `PROPS_NOT_FOUND_MAX_ATTEMPTS = 2` — attempts for `not-found`.
- `PROPS_SERVER_ERROR_MAX_ATTEMPTS = 3` — attempts for `server-error`.
- `PROPS_AUTOLOAD_MAX_ATTEMPTS = 5` — attempts on the `model_select`
  autoload=true path (longer, because awaited and user-visible).
- Cooldown durations (ms) for the negative cache (`failedProps`):
  `PROPS_COOLDOWN_NOT_LOADED_MS = 5_000`,
  `PROPS_COOLDOWN_SERVER_ERROR_MS = 30_000`,
  `PROPS_COOLDOWN_NETWORK_ERROR_MS = 10_000`. These define the minimum
  gap between retry rounds for the same model; double them on the
  `before_provider_request` probe path.
- Keep the existing `PROPS_TIMEOUT_MS` as a legacy alias / overall
  ceiling if any caller still uses it, but stop passing it as the
  per-attempt timeout.

Use a small backoff helper (e.g. `delayForAttempt(attempt, baseMs)`
with full jitter, see e.g. AWS "exponential backoff and jitter") — do
not hand-roll delays in the retry loop. The helper is pure and tested.



`model_select` calls `discoverModelProps(..., true)` so selecting a model
loads it. With autoload=true, the server will not return `not-loaded`
during a normal load — it triggers `ensure_model_ready` which can race
with another load and may return `500` (already silenced today). Changes
on this path:

- **Clear the `failedProps` entry for the selected model at the start
  of `discoverModelProps`** when called from `model_select`. The user
  explicitly chose this model; give it a fresh chance with
  autoload=true regardless of prior failures. (The reconnect-handling
  half lives in Change 4.)
- **Use the longer autoload retry budget** from Change 3
  (`PROPS_AUTOLOAD_MAX_ATTEMPTS`) — the call is awaited and the user
  is waiting on selection, so more aggressive retry is worth it.
- The existing `autoload && 500` silencing stays in `fetchModelProps`;
  the retry loop in `discoverModelProps` will simply retry, and once
  the load completes the next attempt returns `ok`.

## Files touched

- `packages/pi-llama/src/discovery.ts` — `fetchModelProps`: read body,
  classify, return typed result; use the shorter
  `PROPS_ATTEMPT_TIMEOUT_MS` per call (overridable for tests); keep
  abort/stale handling and the existing `autoload && 500` silence (now
  routes to `server-error` with `retryable: true`).
- `packages/pi-llama/src/index.ts` — `discoverModelProps`: consume typed
  result, own the **retry loop with bounded backoff**, own the
  `failedProps` negative cache with cooldown; clear `failedProps` on
  `session_shutdown`, `session_start`, `model_select`, and on SSE
  `loaded` events; emit scoped `ctx.ui.notify` only after retries
  settle. No change to `before_provider_request`'s autoload=false
  choice (only to how its result is handled — silenced via cache).
- `packages/pi-llama/src/constants.ts` — add the retry / cooldown /
  per-attempt-timeout constants from Change 8; keep
  `PROPS_TIMEOUT_MS` as a legacy alias only.
- `packages/pi-llama/src/types.ts` — add the `fetchModelProps` result
  variant type with a `retryable` hint (see Change 2).
- `packages/pi-llama/src/sse.ts` — when `onLoaded` fires, signal
  `index.ts` to clear the matching `failedProps` entry (small hook;
  pass a callback into `SseManager` or expose a method). Keep all
  existing SSE behavior.

No changes to `commands.ts` or `config.ts`. The offline-fallback
registration path is untouched. `sse.ts` gets a small hook (see
above) but its existing connection management is unchanged.

## Tests to add

`packages/pi-llama/tests/config.test.ts` only covers config today; add a
new `discovery.test.ts` that tests `fetchModelProps` classification by
mocking `fetch` (global). Cover happy path, failure path, and edge for
each variant. Use `bun:test`'s fake timers + a controllable fetch mock
so retry timing is deterministic (don't sleep in tests):

- **`ok`**: server returns valid props JSON with `n_ctx` and a
  `chat_template` containing `enable_thinking` → `ok` with
  `supportsThinking: true` and the real `n_ctx`.
- **`ok` edge**: props JSON missing `n_ctx` → `ok` with
  `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS`.
- **`not-loaded`**: status `400`, body
  `{ "error": { "code": 400, "message": "model is not loaded", "type": "invalid_request" } }`
  → `not-loaded` with `retryable: true`; no warning logged.
- **`not-found`**: status `400`, body
  `{ "error": { "code": 400, "message": "model 'x' not found", "type": "invalid_request" } }`
  → `not-found` with `retryable: true`.
- **`endpoint-missing`**: status `404` with non-JSON or empty body →
  `endpoint-missing` with `retryable: false`.
- **`server-error` autoload=true**: status `500` with autoload=true →
  silent (existing behavior preserved); `retryable: true`.
- **`server-error` autoload=false**: status `503` → `server-error`,
  `retryable: true`.
- **`error`**: fetch rejects with abort → `error`, no throw.
- **malformed body**: status `400` with body `"not json"` → falls back
  to `error` (treated transient); never throws.

Then add index-level tests (mock `fetch` globally) for the
**retry + cache + reconnect** behavior, which are the core robustness
fixes:

- **Retry recovers**: `not-loaded` twice, then `ok` on the third attempt
  → `fetch` is called 3 times, the final result is `ok`, the model
  metadata is applied, and `ctx.ui.notify` is never called.
- **Retry exhausts budget**: `not-found` returns `not-found` twice and
  we hit `PROPS_NOT_FOUND_MAX_ATTEMPTS` → `ctx.ui.notify` called once
  with a warning mentioning "usable"/"default context window"; no
  further fetches within the cooldown.
- **Cooldown skips network**: after a `not-loaded` exhaustion, a
  subsequent `before_provider_request` call within the cooldown window
  does **zero** fetches and **zero** notifies.
- **Cooldown expires and re-probes**: after the cooldown window (use
  fake timers), the next `before_provider_request` re-probes the
  network.
- **`model_select` clears cache**: prior `not-found` give-up + a new
  `model_select` for the same model → cache entry cleared, autoload
  retry budget (`PROPS_AUTOLOAD_MAX_ATTEMPTS`) used, succeeds → metadata
  applied.
- **`session_start` clears cache**: a `not-found` give-up is recorded,
  then `session_start` fires → cache cleared for the backend.
- **SSE `loaded` event clears stale `not-loaded`**: cache has a
  `not-loaded` entry; SSE reports the model as `loaded` via the new
  hook → cache entry removed; next probe is allowed.
- **`endpoint-missing` never retries**: status `404` once → caller does
  not retry (only 1 fetch), `ctx.ui.notify` called once (info), cache
  entry marked `giveUp: true`.
- **Backoff delays are bounded**: assert total retry-loop wall time
  stays under a reasonable ceiling (e.g. 60s worst case for the
  autoload path) so the overall budget doesn't regress from today's
  single 120s attempt.
- **Abort kills retry loop**: if the abort signal fires mid-retry,
  the loop exits cleanly without further fetches and without throwing.

Run with `bun:test` (the existing test runner). Keep tests behavioral:
assert on the returned variant, fetch call count, the warn/notify call
counts, and the cache skip behavior — not on internal map shape.

## Tasks

- [ ] **types.ts**: add the `fetchModelProps` result variant type with
  a `retryable` hint (`ok`, `not-loaded`, `not-found`,
  `endpoint-missing`, `server-error`, `error`).
- [ ] **discovery.ts**: in `fetchModelProps`, on `!response.ok` read and
  parse the error body (guarded), classify into the typed result, keep
  the existing `autoload && 500` silencing and abort/stale handling.
  Use `PROPS_ATTEMPT_TIMEOUT_MS` (not `PROPS_TIMEOUT_MS`) as the
  per-call abort. Return the typed result instead of `undefined`.
- [ ] **discovery.ts**: on the `ok` path, return the same
  `contextWindow`/`maxTokens`/`supportsThinking` fields as today.
- [ ] **constants.ts**: add `PROPS_ATTEMPT_TIMEOUT_MS`, the
  per-variant `*_MAX_ATTEMPTS` retry budgets, and the cooldown
  durations from Change 8.
- [ ] **constants.ts / utility**: add a pure `delayForAttempt(attempt,
  baseMs, jitter?)` backoff helper (full jitter) with its own unit
  test.
- [ ] **index.ts**: add `failedProps` to `sessionState` (keyed by
  `providerId:modelId`) storing `{ variant, giveUp, cooldownUntil }`;
  consume the typed result in `discoverModelProps`.
- [ ] **index.ts**: implement the **retry loop with bounded backoff**
  in `discoverModelProps` per Change 3 — retry only
  `retryable === true` variants; honor per-variant attempt counts;
  abort cleanly on signal / "stale after session replacement".
- [ ] **index.ts**: skip the network probe entirely when `failedProps`
  has a `giveUp === true` entry (or `cooldownUntil > now`); keep
  fallback metadata in either case.
- [ ] **index.ts**: map `not-loaded` to silent no-op on the
  `before_provider_request` (autoload=false) path — no warn, no notify,
  rely on the cache to prevent re-probes inside the cooldown.
- [ ] **index.ts**: emit scoped `ctx.ui.notify` **after** retries
  settle — once for `not-found` (warning, mention model still usable),
  once per backend for `endpoint-missing` (info), once per model per
  cooldown for `server-error` (warning). Never notify on `not-loaded`
  or transient abort.
- [ ] **index.ts**: clear the `failedProps` entry on `model_select`
  (fresh chance with autoload=true); clear all `failedProps` in
  `session_start` (reconnect) and `session_shutdown`.
- [ ] **sse.ts**: when `onLoaded` fires, signal `index.ts` to remove
  the matching `failedProps` entry (small hook via callback or
  `SseManager` method). Keep all existing SSE behavior.
- [ ] **index.ts**: add the id round-trip debug check (Change 6) — log
  only, no behavior change.
- [ ] **tests/discovery.test.ts**: variant classification tests (happy,
  failure, edge per variant, malformed body, no-warn for `not-loaded`,
  `retryable` hint correct per variant).
- [ ] **tests**: index-level retry tests using fake timers — recovers
  on Nth attempt, exhausts budget and notifies once, cooldown skips
  network, cooldown expires and re-probes, `model_select` clears cache,
  `session_start` clears cache, SSE `loaded` clears stale `not-loaded`,
  `endpoint-missing` never retries, backoff total wall time bounded,
  abort kills retry loop.
- [ ] **tests**: backoff helper unit test — delays stay within bounds,
  monotonic with jitter.
- [ ] `npm run typecheck` (or `tsc --noEmit`) passes.
- [ ] `bun test packages/pi-llama` — all pass.
- [ ] `pi reload` loads without errors; selecting the
  `unsloth/gemma-4-31B-it-qat-GGUF:Q4_K_XL` model no longer prints the
  `returned 400` spam (it retries silently, succeeds once the model is
  loaded, and applies discovered metadata); the model remains usable
  even when retries don't succeed.
- [ ] Manually verify with a router-mode llama.cpp server: a
  not-loaded model produces no warning on repeated requests; an unknown
  model id produces exactly one actionable warning; after a server
  restart (`session_start`) a previously-failed model is reprobed.

## Attribution

`pi-llama` is part of `bhubbb/pi-extensions` (EUPL-1.2). The discovery
and SSE plumbing are preserved; this change only refines how `/props`
non-OK responses are classified, cached, and surfaced.
