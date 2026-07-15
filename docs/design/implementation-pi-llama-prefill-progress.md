# Implementation: pi-llama prompt-processing progress in the `⠧ Working…` spinner

## Why we're doing this

When a user submits a prompt to a local llama.cpp backend, the wall-clock
time before the first token appears is dominated by **prompt processing**
(pre-fill): the server tokenizes the prompt and pushes every token through
the transformer to fill the KV cache. For large prompts this can be many
seconds — long enough that the existing `⠧ Working…` spinner feels frozen,
even though the server is doing real work and could be telling us how far
along it is.

We want:

1. **A live percentage in the `Working…` line** while pre-fill is in
   progress, sourced from llama.cpp's own progress reporting — not a
   guess, not a fake animation that increments on a timer.
2. **No behavior change for non-llama.cpp providers.** If the model isn't
   llama-cpp, the spinner stays exactly as it is today.
3. **No main-view clutter.** The percentage rides inside the existing
   working-message line that the streaming loader already renders.
4. **Resilient rollback.** If the server doesn't emit progress (older
   llama.cpp builds, oMLX, anything else the `streamSimple` is pointed
   at), we fall back to the default `Working…` text — silently, no
   spinners stuck on "0%".

This is the implementation chosen from the trade-off write-up: the only
way an extension can see pre-fill progress is to own the request via
`streamSimple`, because pi-ai's `openai-completions.js` silently drops
any SSE chunk whose `choices` array is empty (verified at line ~246:
`if (!choice) continue;`). A `prompt_progress` event from llama.cpp has
no `choices` field, so without `streamSimple` the progress is invisible.

## Flow

```
User submits prompt (model = llama-cpp/*)
  │
  ▼
before_provider_request  ──►  payload stays standard (no flag injection needed;
                              streamSimple sets the flag itself)
  │
  ▼
streamSimple(model, ctx, opts)  ──►  POST <baseUrl>/chat/completions
  │                                     body: { ..., stream: true,
  │                                            include_prompt_progress: true }
  │                                     ← SSE lines
  │
  │   ── "data: {\"prompt_progress\":{...}}"  ──►  push no AssistantMessageEvent
  │                                                  ctx.ui.setWorkingMessage(
  │                                                    `⠧ Working… ${pct}%`)
  │
  │   ── "data: {\"choices\":[{...delta}]}"  ──►  ctx.ui.setWorkingMessage()  (restore default)
  │                                                  map to AssistantMessageEvent
  │                                                  (text_delta / thinking_delta /
  │                                                   toolcall_delta / done / error)
  │
  │   ── stream ends / abort / network error  ──►  restore default working message
  │                                                  emit final `done` or `error`
  ▼
back to standard message pipeline (no other behavior changes)
```

The progress update path is a side-channel into the TUI via
`ctx.ui.setWorkingMessage(...)`. It deliberately does **not** push a new
`AssistantMessageEvent` — there is no event for this in
`AssistantMessageEvent`, and inventing one would require a pi-ai protocol
change outside this repo's scope.

## What already exists (do not rebuild)

- **Provider registration:** `registerBackendProvider` in
  `packages/pi-llama/src/provider.ts` already calls
  `pi.registerProvider(providerId, config)` with `api: "openai-completions"`
  for each backend. This is where we add `streamSimple`.
- **`streamSimple` escape hatch:** `ProviderConfig.streamSimple` is a
  fully supported field in `@earendil-works/pi-coding-agent`'s
  `ProviderConfig` (see `dist/core/extensions/types.d.ts`,
  `registerProvider` signature). When set, pi-ai's default openai
  completion stream is **bypassed entirely** for that provider; the
  extension owns the HTTP request, the SSE parse, and the emission of
  every `AssistantMessageEvent`.
- **`ctx.ui.setWorkingMessage(message?)`:** in-place text mutation of the
  streaming loader's line (verified in
  `node_modules/@earendil-works/pi-tui/dist/components/loader.ts` and the
  `ExtensionUIContext` interface). Pass `undefined` (or no argument) to
  restore the default.
- **`ctx.ui.setWorkingVisible(false)`** — referenced here only to note
  we are **not** touching it. The built-in loader row stays visible.
- **`pi-llama` model-loading SSE machinery** in
  `packages/pi-llama/src/sse.ts` (`SseManager`, `processSseEvent`,
  `MODEL_LOAD_STAGE_LABELS`). This is *separate* code: it watches the
  `/models` SSE endpoint for weight-loading progress and updates a
  `Loader` object directly. Pre-fill progress rides a different endpoint
  (the chat-completion stream) and updates the loader via a different
  path (`ctx.ui.setWorkingMessage`). We will not unify them — they have
  different lifetimes, different message shapes, and different cleanup
  semantics.
- **`before_provider_request` handler** in `packages/pi-llama/src/index.ts`
  (around line 369) already runs `discoverModelProps(autoload=false)`.
  The handler will not need to inject anything new — `streamSimple`
  sets `include_prompt_progress` itself, so we leave the standard payload
  alone. **Decision:** keep `before_provider_request` unchanged for this
  feature. Touching it is unnecessary and risks regressing the
  autoload-false fix from the recent commit history.
- **OpenAI chat-completions reference parser:** pi-ai's
  `dist/api/openai-completions.js`. We re-implement the relevant slice
  in the extension. The slice we need to mirror is small and stable:
  `choice.delta.content` → `text_delta`; reasoning fields
  (`reasoning_content` / `reasoning` / `reasoning_text`, first
  non-empty wins) → `thinking_delta`; `choice.delta.tool_calls` →
  `toolcall_*`; `choice.finish_reason` → final `done`; `chunk.usage`
  → usage attached to the final `done`'s `partial`. **We will mirror
  this exactly** — drifting is the main risk of `streamSimple`-based
  extensions and we mitigate it by copying the exact field names and
  precedence.

## What we're changing

### Change 1: new module `packages/pi-llama/src/prefill-stream.ts`

Holds the `streamSimple` function and its helpers. Kept separate from
`sse.ts` (model-loading SSE) and `discovery.ts` (REST discovery) for the
same reason the others are separate: different endpoints, different
lifetimes.

```ts
// packages/pi-llama/src/prefill-stream.ts (outline)

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export function createPrefillStream(
  piContext: ExtensionContext,
  ctx: Context,
): (model: Model<Api>, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (model, options) => streamPrefillCompletion(model, ctx, options, piContext);
}

function streamPrefillCompletion(
  model, context, options, piContext: ExtensionContext,
): AssistantMessageEventStream { ... }
```

The exported factory takes the extension's `ExtensionContext` (which is
how we reach `ctx.ui.setWorkingMessage`) plus the agent's `Context`
(messages, system prompt, tools). It returns the function shape
`ProviderConfig.streamSimple` expects.

**Provider scope guard.** The factory is only passed to
`registerProvider` for `llama-cpp*` providers. The function itself can
assume it is being called for a llama.cpp backend — but we still
**defensively no-op** if `model.provider` doesn't start with
`llama-cpp`, because the registry can race model switches and we don't
want a stray call to write to another model's spinner.

### Change 2: SSE fetch + line parser

Inside `streamPrefillCompletion`:

1. Build the request body by translating pi-ai's `Context` into
   llama.cpp's chat-completions shape (`messages`, `system_prompt`,
   `tools`, `temperature`, `max_tokens`, `stream: true`,
   `include_prompt_progress: true`, plus the model's `chat_template_kwargs`
   such as `enable_thinking`). This translation is the bulk of the file
   — copy the shape from pi-ai's `openai-completions.js` payload builder,
   add the `include_prompt_progress: true` line, and **add nothing else**.
2. `POST` to `<baseUrl>/chat/completions` with `Authorization: Bearer
   <apiKey>` only when the backend's `authHeader` is true and the key is
   real (mirror pi-llama's existing key-resolution convention).
3. Open the response body with a `ReadableStreamDefaultReader` and a
   `TextDecoder`. Split on `\n\n` (SSE event boundary). For each event,
   split lines, pick the ones starting with `data: `, strip the prefix,
   and `JSON.parse`.
4. For each parsed object:
   - **Has `prompt_progress`:** update the working message, do **not**
     push an event. Specifically:
     ```ts
     const p = obj.prompt_progress;
     if (p && typeof p.total === "number" && p.total > 0) {
       const pct = Math.min(100, Math.max(0, Math.round((p.processed ?? 0) / p.total * 100)));
       piContext.ui.setWorkingMessage(`⠧ Working… ${pct}%`);
     }
     ```
     Use the same braille character the default loader uses so the
     line width is stable; if the theme has already replaced the
     indicator via `setWorkingIndicator`, this still reads correctly.
   - **Has `choices`:** translate to `AssistantMessageEvent` exactly as
     pi-ai does (see Change 3). On the **first** such chunk, call
     `piContext.ui.setWorkingMessage()` (no argument) to restore the
     default text.
   - **Has `error`:** push an `error` event with `stopReason: "error"`
     and `errorMessage: obj.error.message ?? "llama.cpp error"`.
   - **Has neither and is not `[DONE]`:** ignore. (Forward-compat for
     new event types.)

5. On stream end: if the `done` event was already emitted, return. If
   the stream ended without a `done` (truncated SSE), emit `error` with
   `stopReason: "error"` and `errorMessage: "stream ended without
   completion"`. Either way, **always** call
   `piContext.ui.setWorkingMessage()` to restore the default — this is
   the leak-prevention guarantee called out in the risks section.

6. Cancellation: respect `options?.signal` (pi passes the request's
   `AbortSignal`). On abort, abort the fetch reader, restore the
   working message, and emit `error` with `stopReason: "aborted"`.
   **No exception thrown out of `streamSimple`** — the agent treats
   stream errors as a regular `error` event.

### Change 3: assistant-event translation (the re-implementation slice)

This is the load-bearing part. We mirror pi-ai's parser closely enough
that no pi-agent-core consumer can tell the difference. Specifically:

- **Text:** `choice.delta.content` (string, length > 0) → `text_delta`
  appended to a single text block.
- **Reasoning:** scan `["reasoning_content", "reasoning",
  "reasoning_text"]` on `choice.delta`, take the first non-empty string.
  Map to `thinking_delta`. Preserve the same `thinkingSignature` rule
  (`"reasoning_content"` only when `model.provider === "opencode-go"`
  — irrelevant here because we're scoped to llama-cpp, so default to the
  field name itself).
- **Tool calls:** `choice.delta.tool_calls[]` → accumulate by `id` into
  a map, emit `toolcall_start` (with `id`/`name` when first seen),
  `toolcall_delta` (with the running `partialArgs`), `toolcall_end` (with
  parsed `arguments`) once the tool call's `arguments` JSON parses.
  Use `parseStreamingJson` from `partial-args.ts` if pi-ai exposes it;
  otherwise inline the standard `try { JSON.parse(acc) } catch {}`
  pattern.
- **Finish:** `choice.finish_reason` maps via pi-ai's `mapStopReason`
  to one of `"stop" | "length" | "toolUse" | "error" | "aborted"`.
  Emit `done` with the assembled `AssistantMessage`.
- **Usage:** `chunk.usage` (or `choice.usage`) is attached to the
  final `done` event's `message.usage`, **not** emitted as a separate
  event. Mirror pi-ai's `parseChunkUsage`.
- **Reasoning details (encrypted):** pi-ai has special handling for
  `reasoning_details` on tool calls (`thoughtSignature`). llama.cpp
  doesn't emit these, so the slice is a no-op for us — but the field
  is on the `AssistantMessage` shape, so the final `done` must include
  an empty `reasoningDetails` array if any block exists, to keep the
  downstream code from crashing on `undefined.length`.

The single most important property: **the `partial` object on every
event must mutate by reference** the way pi-ai does, so the agent's
streaming UI sees in-place updates rather than snapshot churn. We
build a single `output: AssistantMessage` at stream start and pass the
same reference as `partial` on every event we push.

### Change 4: wire `streamSimple` into `registerBackendProvider`

In `packages/pi-llama/src/provider.ts`, add the `streamSimple` field to
the `pi.registerProvider(...)` call. The factory closes over the
`ExtensionContext` — but `registerProvider` doesn't receive a context.
Resolution: store the `ExtensionContext` in a module-scoped variable
inside `index.ts` (e.g., `let activeCtx: ExtensionContext | undefined`),
and have `registerBackendProvider` accept a second arg or read it via a
small `getActiveContext()` accessor.

**Cleaner alternative:** keep the factory bound inside `index.ts` and
pass it through. The current shape is `registerBackendProvider(pi,
backend, models)`; we extend it to `registerBackendProvider(pi, backend,
models, ctx)`. Callers (the `session_start` handler and the offline
fallback in `index.ts`) already have `ctx` in scope.

```ts
// provider.ts
export function registerBackendProvider(
  pi: ExtensionAPI,
  backend: ResolvedBackend,
  models: DiscoveredModel[],
  ctx: ExtensionContext,
): void {
  setModels(backend.providerId, models);
  pi.registerProvider(backend.providerId, {
    name: `llama.cpp${...}`,
    baseUrl: backend.baseUrl,
    apiKey: backend.apiKey,
    api: backend.api,
    authHeader: backend.authHeader,
    streamSimple: (model, context, options) =>
      streamPrefillCompletion(model, context, options, ctx),
    models: models.map(...),
  });
}
```

`registerAllProviders` gets the same signature update and threads
`ctx` through to each call.

**Lifetime note:** the `ctx` we capture is the *session_start* `ctx`,
which is replaced on session switch. To handle that, register
`session_before_switch` and `session_shutdown` to clear `activeCtx`,
and re-register providers on `session_start` (which we already do) —
the new registration captures the new `ctx`. This matches the existing
invalidation pattern used by `SseManager`.

### Change 5: a small `WorkingMessageGuard` for safe cleanup

Restoring the default working message on every exit path is easy to
forget. Wrap it in a one-shot RAII-style helper used by `streamSimple`:

```ts
class WorkingMessageGuard {
  private restored = false;
  constructor(private ui: ExtensionUIContext) {}
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.ui.setWorkingMessage();   // default
  }
}
```

Acquire at the top of `streamPrefillCompletion`, `restore()` on **every**
exit path (success, error, abort, exception), and on the first real
`choices` chunk as well so the spinner immediately reverts once tokens
flow.

### Change 6: feature detection (skip when not supported)

Not every llama.cpp server supports `include_prompt_progress`. Some
builds accept the flag and ignore it (no events); some ignore the flag
and never emit. The stream falls back gracefully either way — if no
`prompt_progress` events arrive, the spinner stays at the default text.

But we can short-circuit on detection: if `/props` (already fetched by
`discoverModelProps`) reveals a build without `prompt_progress`, we can
omit the flag and skip the parser's `prompt_progress` branch. This is a
small optimization; the fallback path is the real safety net. **For
this implementation we do not implement the detection — the parser
already handles "no events" correctly.** Document this as future work
in Change 7.

### Change 7: (optional) per-backend toggle + oMLX parity

`packages/pi-omlx` already has its own copy of the model-loading SSE
machinery (`packages/pi-omlx/index.ts` around line 640). If oMLX ever
exposes a pre-fill progress stream, the same `streamPrefillCompletion`
should be reused. For now, the function lives in pi-llama; if oMLX needs
it, the helper moves to a small shared module (e.g.,
`packages/pi-llama-shared/prefill-stream.ts`) and both packages import
it. We document this as the planned evolution but do **not** do the
extraction now — YAGNI.

## Files touched

- **`packages/pi-llama/src/prefill-stream.ts`** *(new)* —
  `createPrefillStream`, `streamPrefillCompletion`, internal SSE parser,
  `WorkingMessageGuard`, body builder. Single file, ~400 lines.
- **`packages/pi-llama/src/provider.ts`** — add `streamSimple` to the
  `pi.registerProvider(...)` call; update `registerBackendProvider` and
  `registerAllProviders` signatures to accept `ctx`.
- **`packages/pi-llama/src/index.ts`** — pass `ctx` to
  `registerBackendProvider` / `registerAllProviders` at all call sites
  (offline fallback, `session_start`, `model_select` re-register after
  props discovery).
- **`packages/pi-llama/README.md`** — one paragraph under "Features"
  noting the spinner progress for llama.cpp backends, and a short note
  under "Caveats" that it's gated on the server emitting
  `prompt_progress` events.
- **`packages/pi-llama/tests/prefill-stream.test.ts`** *(new)* — tests
  below.
- No changes to `discovery.ts`, `sse.ts`, `commands.ts`, `config.ts`,
  `constants.ts`, `types.ts`, or the extension entry point.

## Tests to add

In `tests/prefill-stream.test.ts`, using `bun:test` (matching the rest
of the package). The `streamSimple` function is what we test; we inject
a fake `fetch` and a fake `ExtensionUIContext` (the latter just needs
a `setWorkingMessage` jest-spy).

- **Happy path — progress then tokens.** Feed SSE bytes:
  `data: {"prompt_progress":{"total":100,"processed":42}}\n\n`
  `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`
  `data: [DONE]\n\n`
  Expect: `setWorkingMessage("⠧ Working… 42%")` called once, then
  `setWorkingMessage()` (restore) called once on first choices chunk,
  then a `text_delta` event with `delta: "Hi"`, then a `done` event
  with `stopReason: "stop"`.
- **Progress only, no tokens.** Feed only `prompt_progress` events
  followed by `[DONE]` (no `choices`). Expect: the working message was
  updated, **no** `AssistantMessageEvent` was pushed (the function
  returns an empty stream result), and the default working message
  was restored on stream end. (Edge case: a pre-fill that produces
  zero tokens — e.g., the model emits only reasoning. pi-ai handles
  this by emitting a `done` with empty content; we must too. The
  test feeds a stream with a `choices` chunk whose `delta.content`
  is empty and `finish_reason: "stop"`, and asserts `done` was
  emitted.)
- **Cache field.** Feed a `prompt_progress` with `processed: 30`,
  `cache: 30`, `total: 100`. Expect percentage = 60% (cached tokens
  count as processed). This matches llama.cpp's semantics where
  `processed` already includes cached tokens. Document the choice
  in a code comment.
- **Missing `prompt_progress` fields.** Feed `{"prompt_progress":{}}`
  — no `total`. Expect: no `setWorkingMessage` call, no error. Just
  skipped.
- **Server doesn't support it.** Feed a stream with only
  `choices` events. Expect: `setWorkingMessage` is *not* called for
  progress; the default is restored only on the first choices chunk
  (which is also the first event in this test). No error.
- **Error event.** Feed `{"error":{"message":"oops"}}` then
  `[DONE]`. Expect: a single `error` event with
  `errorMessage: "oops"` and `stopReason: "error"`. Working message
  is restored.
- **Abort mid-stream.** Start the stream, call
  `options.signal.abort()` while the reader is blocked. Expect:
  fetch is aborted, an `error` event is emitted with
  `stopReason: "aborted"`, working message is restored.
- **Truncated stream (no `[DONE]`, no `error`).** Reader returns
  `done` after a `choices` chunk but before any finish. Expect: a
  `done` event is still emitted with `stopReason: "stop"` if the
  last `choices` had a `finish_reason`; otherwise an `error` event
  with `errorMessage: "stream ended without completion"`. Working
  message is restored.
- **Working message restored on every exit path.** Use a single
  test that runs all six "exit" scenarios above and asserts
  `setWorkingMessage()` (restore, no arg) was called for each.
- **Reasoning field precedence.** Feed chunks with
  `delta: { reasoning_content: "a", reasoning: "b" }` and then
  `delta: { reasoning: "c" }`. Expect the first non-empty
  reasoning field wins (`reasoning_content` first time,
  `reasoning` second time) — match pi-ai's behavior exactly.
- **Tool-call streaming.** Feed a sequence of tool-call deltas
  building up a single tool call's `arguments` JSON across multiple
  chunks. Expect: `toolcall_start` once, `toolcall_delta` per
  chunk with the running `partialArgs`, `toolcall_end` once the
  arguments JSON parses. Final `arguments` matches the expected
  object.
- **Provider scope guard.** Call `streamSimple` directly with a
  fake model whose `provider` is `"anthropic"`. Expect: the
  function short-circuits — no fetch is made, no events pushed, no
  working message changes. This guards against the registry race.

No tests for the TUI rendering beyond the `setWorkingMessage` calls —
we test the side-channel contract, not pi's loader component.

## Tasks

- [ ] `packages/pi-llama/src/prefill-stream.ts`: `WorkingMessageGuard`,
      body builder (mirrors pi-ai openai-completions payload + adds
      `include_prompt_progress: true`), SSE parser (line splitter,
      `[DONE]` / `error` / `prompt_progress` / `choices` / nothing
      handlers), `streamPrefillCompletion` orchestration (abort,
      cleanup, restore on every exit).
- [ ] `packages/pi-llama/src/prefill-stream.ts`: `AssistantMessageEvent`
      translation slice mirroring pi-ai (`text_delta`, `thinking_delta`
      with reasoning field precedence, `toolcall_*` with
      `parseStreamingJson`, `done` with `mapStopReason` + `parseChunkUsage`).
- [ ] `packages/pi-llama/src/prefill-stream.ts`: provider scope guard
      (`model.provider` must start with `"llama-cpp"`).
- [ ] `packages/pi-llama/src/provider.ts`: add `streamSimple` to
      `pi.registerProvider(...)` call; thread `ctx` through
      `registerBackendProvider` and `registerAllProviders` signatures.
- [ ] `packages/pi-llama/src/index.ts`: pass `ctx` at all
      `registerBackendProvider` / `registerAllProviders` call sites
      (offline fallback, `session_start`, post-props re-registration).
- [ ] `packages/pi-llama/tests/prefill-stream.test.ts`: all tests
      listed above (happy path, progress-only, cache field, missing
      fields, no-progress fallback, error, abort, truncation, restore
      on every exit, reasoning precedence, tool-call streaming,
      provider scope guard).
- [ ] `bun test packages/pi-llama` — all pass.
- [ ] `tsc --noEmit` on `packages/pi-llama` (root `npm run typecheck`
      covers `packages/pi-advisor` only — typecheck pi-llama directly,
      as the stats-view design doc notes).
- [ ] Manual: start a llama.cpp server with a model that has a
      ≥2k-token prompt, load pi, submit the prompt, confirm the
      spinner reads `⠧ Working… N%` while pre-fill is in progress,
      and reverts to default once tokens stream.
- [ ] Manual: with the same server but `--no-include-prompt-progress`
      (or older build), confirm the spinner behaves exactly as before
      and no errors are logged.
- [ ] Manual: switch to an Anthropic model mid-session, submit a
      prompt, confirm the spinner behaves exactly as before (the
      scope guard means our parser is never invoked).
- [ ] Update `packages/pi-llama/README.md` features + caveats.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| `streamSimple` re-implementation drifts from pi-ai's parser (reasoning fields, tool calls, usage) | Mirror exact field names + precedence; the test suite pins this. If pi-ai ships a fix to a bug, we inherit the bug until we copy the fix — acceptable trade-off for staying inside this repo. |
| Spinner text leaks into the next turn if restore is forgotten on an error path | `WorkingMessageGuard.restore()` is the only path that resets; called from a single `try/finally`-equivalent at every exit. Test "restore on every exit path" pins this. |
| `include_prompt_progress` accepted by some builds but events never arrive | Parser silently treats this as "no progress" — spinner stays at default. Verified by the "server doesn't support it" test. |
| `ExtensionContext` captured at `session_start` is stale after a session switch | `session_before_switch` / `session_shutdown` handlers clear the captured ctx; providers are re-registered on the next `session_start` with the new ctx (existing pattern from `SseManager`). |
| Request body shape diverges from what llama.cpp expects (e.g., `chat_template_kwargs` placement) | Test with a real server in the manual checks; keep the body builder close to pi-ai's by reading both files side-by-side during code review. |
| Two pi processes writing to the same working message slot | Not a real issue — each pi has its own TUI instance. |
| Long prompts cause many `setWorkingMessage` calls per second, hurting render performance | pi's `setWorkingMessage` is a cheap in-place text update (no full re-render). Even 10 calls/s is fine. If profiling shows otherwise, debounce to 5 Hz — but defer until measured. |
| oMLX backend diverges later | Documented future evolution (Change 7); same helper would be extracted to a shared module. |
| `[DONE]` token differs across llama.cpp builds (some send it, some don't) | Treat stream end as the source of truth — `[DONE]` is *optional*. The `done`/`error` decision is driven by the last `choices.finish_reason` and the reader's `done` flag, not by `[DONE]`. |

## Attribution

`pi-llama` is part of `bhubbb/pi-extensions` (EUPL-1.2). This change
follows the same defensive-parsing + revert-on-failure pattern as the
model-loading SSE work in `packages/pi-llama/src/sse.ts` and the
read-only stats view in
`docs/design/implementation-llama-stats-view.md`.
