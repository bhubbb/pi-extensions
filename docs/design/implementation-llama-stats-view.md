# Implementation: pi-llama-stats — llama.cpp server stats view

## Why we're doing this

When using local llama.cpp backends (registered by `pi-llama`), there is no
quick way to see **server + model metrics** (slot state, tokens/s, loaded
models, build info) from inside pi. We want:

1. **A hotkey** that opens a dedicated **view** showing per-backend stats.
2. **No main-view clutter** — the view is an overlay, opened on demand and
   dismissed with `escape`/`q`. Nothing is added to the footer or widget
   area when the view is closed.
3. **A new package** (`packages/pi-llama-stats`) that is only meaningful when
   pi-llama backends are configured. If none are configured, the hotkey is a
   no-op with a notify.

**Scope guard:** this package only *reads* stats. It does not load/unload
models, change slots, or mutate server state. No POST endpoints.

## How it fits together (flow)

```
press Ctrl+Shift+L  ──▶  pi.registerShortcut handler
                            │
                            ├─ resolve backends (read pi-llama config)
                            ├─ if none → ctx.ui.notify("No llama.cpp backends")  return
                            └─ ctx.ui.custom(<StatsView>, { overlay: true })
                                          │
                                          ├─ fetch /props, /slots, /v1/models, /health  (+ /metrics if enabled)
                                          ├─ render() → lines (one block per backend)
                                          ├─ 2s auto-refresh timer → tui.requestRender()
                                          └─ escape / q → done()  (clears timer)
```

Also register a `/llama-stats` command (same handler) so it is discoverable
and usable without memorizing the hotkey.

## What already exists (do not rebuild)

- **`pi-llama` config** lives at `~/.pi/agent/pi-llama.json` with shape:
  `{ version?: number, backends: LlamaBackendConfig[] }` where each backend
  has `baseUrl`, `apiKey?`, etc. See `packages/pi-llama/README.md` and
  `packages/pi-llama/src/types.ts` (`LlamaBackendConfig`, `PersistedConfig`).
  **This schema is owned by pi-llama.** The stats package only *reads*
  `backends[].baseUrl` and `backends[].apiKey` and must tolerate any other
  fields/missing fields without error.
- **Legacy env vars** `LLAMA_BASE_URL` / `LLAMA_API_KEY` configure a single
  backend (provider id `llama-cpp`). Resolution priority is documented in
  `packages/pi-llama/src/config.ts` (`resolveConfig`): env var → persisted
  file → models.json → defaults.
- **TUI overlay API**: `ctx.ui.custom((tui, theme, keybindings, done) =>
  component, { overlay: true, overlayOptions: {...} })`. See pi docs
  `tui.md` (Overlays) and the `doom-overlay` example
  (`examples/extensions/doom-overlay/index.ts`).
- **Shortcut API**: `pi.registerShortcut("ctrl+shift+l", { description,
  handler: async (ctx) => {...} })`. See pi docs `extensions.md`
  (`pi.registerShortcut`) and `plan-mode/index.ts` for a real example.
- **Component contract**: `{ render(width): string[], handleInput?(data),
  invalidate() }`. Each line must not exceed `width`. Use
  `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui`.

## llama.cpp server endpoints (authoritative source: llama.cpp server README)

All endpoints are on the **root** URL (strip the trailing `/v1` from the
configured `baseUrl`, exactly like `pi-llama` does in `commands.ts` for
`/props`). Send `Authorization: Bearer <apiKey>` only when `apiKey` is set
and not `"no-key"` (mirror pi-llama's `authHeader` behavior; default
`false`).

| Endpoint | Default on? | What we use from the response |
|---|---|---|
| `GET /props` | yes (read-only GET) | `build_info`, `model_path`, `total_slots`, `is_sleeping`, `default_generation_settings.n_ctx` |
| `GET /slots` | yes (disable with `--no-slots`) | array: per slot `id`, `is_processing`, `n_ctx`, `speculative`, `next_token.n_decoded`, `next_token.n_remain`. **Read all fields defensively** (`?.`); some server builds also expose `n_past`, `n_tokens`, `truncated`, `model`, `cache`, `timing.predicted_per_second`, `timing.prompt_per_second` — show them when present. |
| `GET /v1/models` | yes | `data[]`: `id`, `status.value` (`unloaded`/`loading`/`loaded`/`sleeping`), `meta.n_params`, `meta.size`, `meta.n_ctx_train` |
| `GET /health` | yes (public, no API key) | `status` (`"ok"` or 503 `{"error":...}` while loading) |
| `GET /metrics` | **no** (needs `--metrics`) | Prometheus text. If 200, parse these gauges/counters: `llamacpp:prompt_tokens_seconds`, `llamacpp:predicted_tokens_seconds`, `llamacpp:requests_processing`, `llamacpp:requests_deferred`, `llamacpp:prompt_tokens_total`, `llamacpp:tokens_predicted_total`. If 501/404, skip silently. |

**Error handling per backend:** if a fetch throws (server offline) or
returns non-200, render a single `Backend N: unreachable (<msg>)` line for
that backend and continue with the others. Never let one backend's failure
blank the whole view.

**Timeout:** every fetch uses an `AbortController` with a 3000ms timeout
(reuse the pattern from `packages/pi-llama/src/discovery.ts`
`fetchModelProps`).

## Package layout — `packages/pi-llama-stats/`

```
packages/pi-llama-stats/
  package.json
  tsconfig.json            (extend root tsconfig, same as pi-llama)
  README.md                (short: install + hotkey + command)
  src/
    index.ts               extension factory: register shortcut + command
    config.ts              minimal backend resolver (read pi-llama.json + env)
    stats.ts               fetch + parse functions, types
    view.ts                StatsView component (render/handleInput/invalidate)
  tests/
    config.test.ts         resolution priority + missing file + env precedence
    stats.test.ts          parse /props, /slots, /v1/models, /metrics text; defensive on missing fields
```

### `package.json` (key fields)

```json
{
  "name": "pi-llama-stats",
  "version": "0.1.0",
  "description": "llama.cpp server stats overlay view for pi (companion to pi-llama)",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "llama.cpp"],
  "license": "EUPL-1.2",
  "pi": { "extensions": ["./src/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true }
  }
}
```

The root `package.json` already uses `workspaces: ["packages/*"]`, so the
new package is picked up automatically. It is **not** added to the root
`pi.extensions` list (that list is for the advisor-ext publish set). The
stats package is installed/loaded on its own via `pi install` or `pi -e`.

## Module specs

### `src/config.ts` — minimal backend resolver

**Do not import from `pi-llama`.** It is a separate loaded package and its
module-level state (`getCurrentConfig`) is not reachable across packages.
Instead, re-read the same inputs with a small, defensive reader. Keep it
minimal — only what the stats view needs.

Exports:
- `interface StatsBackend { providerId: string; baseUrl: string; rootUrl: string; apiKey: string; authHeader: boolean; }`
  - `rootUrl` = `baseUrl` with trailing `/v1` stripped (use
    `baseUrl.replace(/\/v1$/, "")`).
- `resolveStatsBackends(): Promise<StatsBackend[]>` — priority:
  1. If `process.env.LLAMA_BASE_URL` is set → single backend, `providerId:
     "llama-cpp"`, `apiKey` from `LLAMA_API_KEY` (or `"no-key"`),
     `authHeader: false`.
  2. Else read `~/.pi/agent/pi-llama.json` (path from
     `os.homedir()/.pi/agent/pi-llama.json`). If `backends` is a non-empty
     array, map to `StatsBackend` with `providerId: "llama-cpp-<index>"`
     (mirrors pi-llama's numbering for multi-backend). `apiKey` default
     `"no-key"`. `authHeader` from `backend.authHeader ?? false`.
  3. Else return `[]` (no backends — hotkey will notify).
- `resolveSingleKey(input?: string): string` — copy pi-llama's env-var
  interpolation (`"!..."` prefix → literal; name in `process.env` → value;
  else literal). Keep behavior identical so the same key strings work.

**Why duplicate this and not share?** Decoupling. pi-llama's config module
is an internal implementation detail that can change; the stats package
depends only on the *documented file format* (`backends[].baseUrl/apiKey`),
which is stable. The duplication is ~40 lines.

### `src/stats.ts` — fetch + parse

Exports:
- `interface BackendStats { backend: StatsBackend; error?: string; props?: PropsStats; slots?: SlotStats[]; models?: ModelStats[]; health?: { status: string }; metrics?: MetricsStats; fetchedAt: number; }`
- `interface PropsStats { buildInfo?: string; modelPath?: string; totalSlots?: number; isSleeping?: boolean; nCtx?: number; }`
- `interface SlotStats { id: number; isProcessing: boolean; nCtx?: number; speculative?: boolean; nDecoded?: number; nRemain?: number; nPast?: number; nTokens?: number; truncated?: boolean; model?: string; predictedPerSecond?: number; promptPerSecond?: number; }`
- `interface ModelStats { id: string; status?: string; nParams?: number; size?: number; nCtxTrain?: number; }`
- `interface MetricsStats { promptTokensPerSecond?: number; predictedTokensPerSecond?: number; requestsProcessing?: number; requestsDeferred?: number; promptTokensTotal?: number; tokensPredictedTotal?: number; }`
- `fetchBackendStats(backend: StatsBackend, signal?: AbortSignal): Promise<BackendStats>` — runs the 5 fetches in parallel via `Promise.allSettled`, packs into `BackendStats`. Each sub-fetch has its own try/catch so a single endpoint failure (e.g. `/metrics` 501) does not fail the whole backend. `error` is set only if `/props` *and* `/slots` *and* `/health` all fail (treat as unreachable).
- `parseMetricsText(text: string): MetricsStats` — regex-pull the named
  Prometheus gauges/counters. Lines look like
  `llamacpp:predicted_tokens_seconds 52.94`. Take the first match per name.
- Helpers: `stripV1(url)`, `authHeaders(backend)` (returns `{}` or
  `{ Authorization: "Bearer " + apiKey }`).

**Defensive parsing rule:** every field is optional. Use `data?.field` and
`Number(x) || undefined`. Never throw on a malformed body — return what you
can and leave the rest undefined.

### `src/view.ts` — StatsView component

A class implementing the pi component contract:

```typescript
class StatsView {
  constructor(backends: StatsBackend[], theme, onDone: () => void);
  // state: stats per backend, scrollOffset, width cache, refreshTimer
  render(width: number): string[];   // themed lines, truncated to width
  handleInput(data: string): void;   // up/down scroll, r refresh, q/escape close
  invalidate(): void;                 // clear width cache
}
```

**Rendered layout** (one block per backend, separated by a blank line):

```
╭─ llama.cpp stats ──────────────────── r refresh · q close ─╮
│ [0] llama-cpp-0  http://localhost:8080   build b1234-abc  │
│   model: /path/to/model.gguf   slots: 2   sleeping: no    │
│   health: ok   ctx: 8192                                   │
│   slots:                                                    │
│     #0  idle     ctx 8192  decoded 0    remain -1          │
│     #1  busy     ctx 8192  decoded 42   remain 158  52.9 tok/s
│   models:                                                   │
│     unsloth/...:Q4_K_M   loaded   8.03B params  4.9 GB    │
│   metrics (prometheus):                                     │
│     prompt 32.3 tok/s  predicted 52.9 tok/s  req 1/0      │
│                                                            │
│ [1] llama-cpp-1  http://remote:8080   unreachable (ECONNREFUSED)
╰────────────────────────────────────────────────────────────╯
```

- Use `theme.fg("accent", ...)` for backend headers, `theme.fg("success",`
  `...)` for `loaded`/`ok`, `theme.fg("warning", ...)` for `busy`/`sleeping`,
  `theme.fg("error", ...)` for unreachable, `theme.fg("muted", ...)` for
  labels. Get `theme` from the `ctx.ui.custom` callback (never import a
  global theme).
- **Scrolling:** if rendered lines exceed available height, keep a
  `scrollOffset` and slice. `up`/`down` move it (clamp at 0 and max).
- **Refresh:** on construction, call `fetchBackendStats` for every backend
  (`Promise.all`) then `requestRender()`. Start a `setInterval(2000)` that
  re-fetches and re-renders. **Clear the interval in `handleInput` on
  `q`/`escape` before calling `onDone()`.** Also clear it if the component
  is replaced (defensive: store the timer id and clear in a `dispose()`
  method called from `onDone`).
- **Abort in-flight fetches on close.** The view owns a single
  `AbortController` whose `signal` is passed into every
  `fetchBackendStats` call (rebuilt per refresh tick so completed fetches
  don't leak aborted state). On `q`/`escape` (and in `dispose()`), call
  `controller.abort()` *before* `onDone()`. This prevents a slow
  `/props`/`/metrics` response from calling `requestRender()` after the
  overlay is gone (which would either no-op or, worse, mutate state on a
  stale component). The per-fetch 3s `AbortController` is layered
  *inside* `fetchBackendStats` and chained off the parent signal via
  `AbortSignal.any([parent, timeout])` (or equivalent) so a parent abort
  short-circuits the per-fetch timeout cleanly.
- **Line width:** every line through `truncateToWidth(line, width)`.

### `src/index.ts` — extension factory

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const openStats = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") { ctx.ui.notify("llama-stats requires TUI mode", "warning"); return; }
    const backends = await resolveStatsBackends();
    if (backends.length === 0) {
      ctx.ui.notify("No llama.cpp backends configured. Use /llama-setup.", "warning");
      return;
    }
    await ctx.ui.custom((_tui, theme, _kb, done) => new StatsView(backends, theme, done), {
      overlay: true,
      overlayOptions: { width: "70%", maxHeight: "90%", anchor: "center", margin: 1 },
    });
  };

  pi.registerShortcut("ctrl+shift+l", {
    description: "Open llama.cpp server stats view",
    handler: openStats,
  });

  pi.registerCommand("llama-stats", {
    description: "Open llama.cpp server stats view",
    handler: openStats,
  });
}
```

`ctrl+shift+l` is **not** in pi's default keybindings (checked against
`keybindings.md`; `ctrl+l` is model-select, `shift+ctrl+p` is cycle-back).
Users can rebind via `~/.pi/agent/keybindings.json` using the id pi assigns
to the shortcut. The command fallback ensures it is always reachable and
appears in `/help`.

## Tests

Match `packages/pi-llama/tests/`, which uses **`bun:test`**
(`import { describe, it, expect, ... } from "bun:test"`). Mock `fetch` by
injecting a fetch function (pass it into the parse/fetch helpers as a
dependency, defaulting to global `fetch`), so tests don't need a live
server.

- **`config.test.ts`**: env var wins over file; file with 2 backends → 2
  `StatsBackend` with `llama-cpp-0/1` ids and `rootUrl` stripped; missing
  file + no env → `[]`; `resolveSingleKey` env-var interpolation.
- **`stats.test.ts`**: parse a sample `/props` JSON → `PropsStats`; parse
  `/slots` array with minimal fields and with extra `timing` fields →
  `SlotStats` only keeps what exists; parse `/v1/models` → `ModelStats`
  with status; `parseMetricsText` extracts the 6 named metrics from a
  sample Prometheus body and ignores unrelated lines; a 501 on `/metrics`
  does not set `error`; all-endpoints-down sets `error`.
- **Boundary:** malformed JSON body for `/props` does not throw (returns
  undefined fields).

No test for the TUI component rendering beyond a smoke "lines fit width"
check (behavior, not pixel-matching).

## Tasks

- [ ] Create `packages/pi-llama-stats/` with `package.json`, `tsconfig.json`,
      `README.md`
- [ ] `src/config.ts`: `StatsBackend`, `resolveStatsBackends`,
      `resolveSingleKey`
- [ ] `src/stats.ts`: types + `fetchBackendStats` (parallel, per-fetch
      try/catch, 3s timeout) + `parseMetricsText` + `stripV1`/`authHeaders`
- [ ] `src/view.ts`: `StatsView` component (render/handleInput/invalidate,
      scroll, 2s refresh timer cleared on close, in-flight fetches aborted
      on close via a view-owned `AbortController` chained with the 3s
      per-fetch timeout)
- [ ] `src/index.ts`: `openStats` handler + `registerShortcut("ctrl+shift+l")`
      + `registerCommand("llama-stats")`
- [ ] `tests/config.test.ts`, `tests/stats.test.ts` (mocked fetch, all pass)
- [ ] `tsc -p packages/pi-llama-stats/tsconfig.json --noEmit` passes
      (the root `npm run typecheck` only covers the advisor package, so
      typecheck this package directly)
- [ ] `bun test packages/pi-llama-stats/tests/` — all pass
- [ ] Manual: start a `llama-server`, load pi with both pi-llama and
      pi-llama-stats, press `Ctrl+Shift+L`, confirm overlay shows slots +
      models + build info; press `r` to refresh; `q` to close; confirm no
      footer/widget residue after close
- [ ] Manual: with no backends configured, `Ctrl+Shift+L` shows the
      "No llama.cpp backends configured" notify and nothing else
- [ ] Commit + push

## Notes / guardrails

- **Read-only.** No POST to `/slots/{id}?action=...`, no `/models/load`.
- **No main-view footprint when closed.** Do not call `ctx.ui.setStatus` or
  `ctx.ui.setWidget`. The overlay is the entire UX.
- **No coupling to pi-llama internals.** Depend only on the documented
  `pi-llama.json` file format. If pi-llama changes its file format, this
  package's resolver is the only thing to update.
- **Config staleness.** Backends are re-read from disk on each hotkey press
  (cheap), so edits via `/llama-setup` are picked up the next time the view
  is opened. The resolver does **not** watch the file mid-session, so a
  backend added while the overlay is open won't appear until re-opened.
  Acceptable for a read-only stats view; document it in the package README.
- **Defensive endpoint parsing.** llama.cpp server response shapes vary
  across builds; read every field as optional.
- **Auth:** only send `Authorization` when the backend has a real key
  (`authHeader` true or `apiKey !== "no-key"`), matching pi-llama.
