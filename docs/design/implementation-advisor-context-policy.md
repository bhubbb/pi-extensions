# Implementation: pi-advisor context policy + always trigger

## Why we're doing this

The upstream `pi-advisor` (from `hknet/pi-extensions`) sends the **entire
conversation transcript** to the advisor model on every review. When the
advisor is a local LLM with a small context window, this is wasteful and
often overflows. We want two things:

1. **Send less context** — instead of the full transcript every time, let
   the user choose to send just the last N messages, a compressed summary,
   or both. The advisor still gets enough to give useful feedback, but we
   stop burning tokens on the whole history.

2. **Run automatically on every turn** — add an `always` trigger so the
   advisor reviews before the agent processes each user message, not just
   when the agent gets stuck or finishes. This makes the advisor a
   per-turn reviewer, shaping the agent's approach from the start.

**Critical constraint:** all existing modes must keep working unchanged.
The `advisor` tool, `/advise` command, `onDone`, and `whenStuck` are
preserved exactly. The new context modes and `always` trigger are
additive.

## What already exists (do not rebuild)

The `src/` modules are already written and present in the repo
(recovered from session history). They implement the context policy
internals. The work is **wiring them into `advisor.ts`** and **adding the
`always` config field**, not reimplementing them.

### `src/config.mjs` — config validation + resolution

Exports:
- `resolveEffectiveConfig(cwd, projectTrusted)` → returns an object with
  `spec`, `source`, `thinking`, `onDone`, `whenStuck`, `timeoutMs`,
  `always`, `contextMode`, `tailMessages`, `stripReasoning`,
  `keepToolResults`, `diffMode`, `diffMaxChars`, `summaryModel`,
  `summaryMaxTokens`, `summaryRefreshEvery`, `summaryTimeoutMs`
- `validateAdvisorConfig(raw, source)` → validates a config object,
  warns on invalid keys, returns clean config
- `readConfig(file)` → reads + validates a JSON config file
- `writeConfig(file, patch)` → merges patch into existing file, writes
- `isDisabled(cfg)` → true if `cfg.spec === "none"`
- `isUnconfigured(cfg)` → true if `cfg.spec === undefined`
- `normalizeDiffMode(mode, projectTrusted)` → downgrades git-* modes to
  non-git when project is untrusted
- `DEFAULTS`, `THINKING_LEVELS`, `DEFAULT_THINKING`, `DEFAULT_TIMEOUT_MS`

**Note:** `isDisabled`/`isUnconfigured` here take a **config object**,
not `(cwd, projectTrusted)`. The local wrappers in `advisor.ts` resolve
config first, then call these.

**Already has `always`** — `DEFAULTS.always`, `envAlways()`, validation,
resolution, and writeConfig merge for `always` were added in a prior
session. Verify they're present; if not, add them (see Tasks).

### `src/context-policy.mjs` — tail selection + payload assembly

Exports:
- `renderEntry(entry, opts)` → renders one branch entry as a string.
  `opts` controls `stripReasoning` and `showToolResults`. Returns null
  for entries that shouldn't be shown.
- `selectTail(entries, tailMessages)` → returns `{ kept, omittedCount,
  firstUserReInserted }`. Keeps the first user message + last N entries.
- `buildAdvisorPayload(entries, mode, opts, model)` → **the core
  function**. Assembles the advisor's transcript text according to
  `mode`:
  - `"full"` → all entries (optionally stripped), oldest-first trimmed on
    overflow
  - `"tail"` → first user + last N + diff digest
  - `"summary"` → summary + diff + last 2-3 msgs, degrades to tail if
    summary unavailable
  - `"summary+tail"` → summary + last N + diff digest
  - `opts` must include: `stripReasoning`, `keepToolResults`,
    `tailMessages`, `diffDigest`, and `summary` (the summary text or
    null)
  - `model` is used for overflow math (maxTokens, contextWindow)
  - Returns a string (the payload text)

### `src/diff.mjs` — patch harvest + digest rendering

Exports:
- `collectChangesFromEvents(events, diffMode, maxChars)` → takes an
  array of accumulated change events (`{ kind, path, patch?, content?,
  command?, isError, ts }`), dedupes by path, returns a changes list
- `renderDigest(changes, verifications, diffMode, maxChars)` → renders
  the changes as a stat or snippets digest string
- `collectChangesFromBranch(entries, diffMode, maxChars)` → fallback:
  reconstructs changes from branch entries (toolCall args)
- `collectChangesFromGit(cwd, mode, maxChars, projectTrusted)` →
  opt-in git diff (requires projectTrusted)
- `countPatchChanges(patch)`, `isVerificationCommand(command)`,
  `renderStatDigest`, `renderSnippetsDigest`

### `src/summarizer.mjs` — summary pre-call + rolling cache

Exports:
- `getSummary(ctx, opts)` → **async**. Returns `{ text, source }` or
  `{ error }`. `opts` must include: `summaryModel`, `entries`,
  `stripReasoning`, `maxTokens`, `timeoutMs`, `signal`, `refreshEvery`,
  `cache`, `setCache`. Uses a rolling cache — only regenerates when the
  branch has grown by `refreshEvery` messages since last summary.
  `summaryModel: "executor"` uses the running model; a spec string uses
  a separate model.
- `SummaryCache` — an empty object template for the cache shape
  (`{ text, branchLen, source }`)
- `SummarySource` — `{ CACHE, EXECUTOR, MODEL }` enum

## What we're changing

### Change 1: `advisor.ts` — import from src/ modules instead of local defs

**Current state:** `advisor.ts` defines all config functions locally
(`resolveEffectiveConfig`, `readConfig`, `writeConfig`,
`validateAdvisorConfig`, `isDisabled`, `isUnconfigured`,
`envThinkingLevel`, `envTimeoutMs`, `DEFAULT_THINKING`,
`DEFAULT_TIMEOUT_MS`, `EffectiveAdvisorConfig`). These conflict with the
src/ module versions.

**Change:** Remove the local definitions. Import from `src/config.mjs`:
`resolveEffectiveConfig`, `normalizeDiffMode`, `isDisabled as
_isDisabled`, `isUnconfigured as _isUnconfigured`, `readConfig`,
`writeConfig`. Keep local wrapper functions `isDisabled(cwd,
projectTrusted)` and `isUnconfigured(cwd, projectTrusted)` that call
`resolveEffectiveConfig` first, then pass the result to the imported
`_isDisabled`/`_isUnconfigured`.

Also import from the other src/ modules:
- `buildAdvisorPayload`, `AnyEntry` from `src/context-policy.mjs`
- `collectChangesFromEvents`, `renderDigest`, `ChangeEvent` from
  `src/diff.mjs`
- `getSummary`, `SummaryCache`, `SummarySource` from
  `src/summarizer.mjs`

### Change 2: `advisor.ts` — add `always` + context fields to AdvisorConfig

Add to the `AdvisorConfig` type:
`always?: boolean`, `contextMode?: string`, `tailMessages?: number`,
`stripReasoning?: boolean`, `keepToolResults?: string`,
`diffMode?: string`, `diffMaxChars?: number`, `summaryModel?: string |
null`, `summaryMaxTokens?: number`, `summaryRefreshEvery?: number`,
`summaryTimeoutMs?: number`.

Add a `ContextMode` type: `"full" | "summary+tail" | "tail" | "summary"`.

### Change 3: `advisor.ts` — add compressed system prompt

Add `ADVISOR_SYSTEM_PROMPT_COMPRESSED` — a variant of the existing
`ADVISOR_SYSTEM_PROMPT` that tells the advisor it's seeing a compressed
view (summary + tail + diff), not the full transcript, and should not
assume it sees every tool result.

Add `systemPromptForMode(mode)` → returns `ADVISOR_SYSTEM_PROMPT` for
`"full"`, `ADVISOR_SYSTEM_PROMPT_COMPRESSED` otherwise.

### Change 4: `advisor.ts` — replace `buildTranscript` with `buildAdvisorPayload` in `runAdvisor`

**Current flow in `runAdvisor`:**
1. Resolve the advisor model (`resolveAdvisor`)
2. Call `buildTranscript(ctx.sessionManager.getBranch(), model)` → gets
   the full transcript as a string
3. Build a request with `ADVISOR_SYSTEM_PROMPT` and the transcript
4. Call `complete(model, request, ...)` → get advice
5. Return `{ text, disabled }`

**New flow:**
1. Resolve the advisor model (same)
2. Resolve config with `resolveEffectiveConfig(ctx.cwd,
   projectTrusted)` to get `contextMode`, `tailMessages`, etc.
3. Get the summary: call `getSummary(ctx, { summaryModel, entries,
   stripReasoning, maxTokens: summaryMaxTokens, timeoutMs:
   summaryTimeoutMs, signal, refreshEvery: summaryRefreshEvery, cache:
   summaryCache, setCache: (c) => { summaryCache = c } })`. If it
   returns `{ error }`, pass `null` as the summary (the payload function
   handles degradation).
4. Get the diff digest: call `renderDigest(
   collectChangesFromEvents(changeEvents, ...), [], diffMode,
   diffMaxChars)`. If empty, pass `undefined`.
5. Call `buildAdvisorPayload(entries, contextMode, { stripReasoning,
   keepToolResults, tailMessages, diffDigest, summary }, model)` →
   gets the payload string
6. Build the request with `systemPromptForMode(contextMode)` instead of
   the hardcoded prompt
7. Call `complete(model, request, ...)` → get advice (same)
8. Return `{ text, disabled }` (same)

**Key point:** `runAdvisor` is the single insertion point. Both the
`advisor` tool and `/advise` call it, so changing it here updates all
paths.

### Change 5: `advisor.ts` — add context-policy closure state

Inside `advisorExtension(pi)`, add:
- `let changeEvents: ChangeEvent[] = []` — accumulates tool_result
  events for diff harvest
- `let summaryCache: SummaryCache | null = null` — rolling summary cache

Reset both to empty/null in the existing `input` event handler (the one
that resets `stuckErrors`, `loopCount`, etc. on genuine user input).

### Change 6: `advisor.ts` — accumulate change events in `tool_result` handler

In the existing `tool_result` handler, before the stuck/loop logic, push
change events into `changeEvents`:
- `event.toolName === "edit"` → push `{ kind: "edit", path, patch,
  isError, ts }` (patch from `event.details.patch`)
- `event.toolName === "write"` → push `{ kind: "write", path, content,
  isError, ts }`
- `event.toolName === "bash"` → push `{ kind: "bash", command, isError,
  ts }`

### Change 7: `advisor.ts` — add `always` trigger

Add a **second** `input` event handler (separate from the reset handler).
It:
1. Resolves config (`resolveEffectiveConfig`)
2. Returns early if `!cfg.always` or `autoRunning`
3. Sets `autoReviewedThisRound = true` (prevents `onDone` from
   double-firing)
4. Calls `runAutomaticReview(ctx, (text) => \`A reviewer model assessed
   the current task before you started:\n\n${text}\n\nAddress any valid
   issues.\`, "steer")`

This runs **before** the agent processes the user's input, injecting the
review as a `steer` so it shapes the current turn.

### Change 8: `config.mjs` — verify `always` field is present

Check that `config.mjs` has:
- `DEFAULTS.always = false`
- `envAlways()` reading `PI_ADVISOR_ALWAYS`
- Validation for `always` in `validateAdvisorConfig`
- `always` in `resolveEffectiveConfig` return (precedence: project >
  global > env > default)
- `always` in `writeConfig` merge

If any are missing, add them.

## Config reference

New keys in `advisor.json` (all optional, all backward compatible):

```json
{
  "always": true,
  "contextMode": "summary+tail",
  "tailMessages": 10,
  "stripReasoning": true,
  "keepToolResults": "recent",
  "diffMode": "stat",
  "diffMaxChars": 4000,
  "summaryModel": "provider/id",
  "summaryMaxTokens": 16384,
  "summaryRefreshEvery": 8,
  "summaryTimeoutMs": 60000
}
```

Set `contextMode: "full"` + `stripReasoning: false` to recover
byte-compat with upstream (sends the entire conversation with reasoning
intact).

Precedence for all keys: `env > project > global > default`.

## Tasks

- [ ] **advisor.ts**: remove local config defs, import from
  `src/config.mjs` (rename imports to `_isDisabled`/`_isUnconfigured`,
  keep wrappers)
- [ ] **advisor.ts**: import `buildAdvisorPayload`, `AnyEntry`,
  `collectChangesFromEvents`, `renderDigest`, `ChangeEvent`,
  `getSummary`, `SummaryCache`, `SummarySource`
- [ ] **advisor.ts**: add `always` + context fields to `AdvisorConfig`
  type
- [ ] **advisor.ts**: add `ContextMode` type
- [ ] **advisor.ts**: add `ADVISOR_SYSTEM_PROMPT_COMPRESSED` +
  `systemPromptForMode()`
- [ ] **advisor.ts**: add `changeEvents` + `summaryCache` closure state,
  reset in existing `input` handler
- [ ] **advisor.ts**: accumulate change events in `tool_result` handler
- [ ] **advisor.ts**: add second `input` handler for `always` trigger
- [ ] **advisor.ts**: replace `buildTranscript` with
  `buildAdvisorPayload` in `runAdvisor` (summary pre-call + diff digest
  + `systemPromptForMode`)
- [ ] **config.mjs**: verify `always` field is present in DEFAULTS,
  envAlways, validation, resolution, writeConfig
- [ ] **package.json** (pi-advisor): update `name` to
  `@bhubbb/pi-advisor`, `files` to include `src/`
- [ ] Fix failing tests (test expectations vs module output —
  `renderEntry` needs `showToolResults` opt, selectTail edge cases,
  digest truncation)
- [ ] `npm run typecheck` passes
- [ ] `node --test packages/pi-advisor/tests/*.test.mjs` — all pass
- [ ] `pi reload` loads without errors, `/advisor status` shows `always`
- [ ] `/advise` runs and uses `summary+tail` payload by default
- [ ] Commit + push to `bhubbb/pi-extensions`

## Attribution

`pi-advisor` is a fork of `hknet/pi-extensions` (EUPL-1.2). The upstream
`advisor` tool, auto-triggers, and `/advise` UX are preserved.
