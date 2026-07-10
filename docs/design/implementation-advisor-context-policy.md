# Implementation: pi-advisor context policy + always trigger + monorepo consolidation

## Goal

Three things, in order:

1. **Consolidate into a monorepo** — move `pi-advisor`, `pi-llama-mb`, and
   `pi-omlx` into one repo (`bhubbb/pi-extensions`) as workspace packages.
   The standalone repos for `pi-llama-mb` and `pi-omlx` stay intact; the
   monorepo is the canonical dev surface going forward.

2. **Add configurable context modes to pi-advisor** — keep every existing
   mode (`onDone`, `whenStuck`, the `advisor` tool, `/advise`), but stop
   always sending the full transcript. Add `full`, `tail`, `summary`, and
   `summary+tail` modes so the advisor can be sent a cheaper view (last N
   messages, a generated summary, or both). Default to `summary+tail`.

3. **Add an `always` auto-trigger** — a new trigger that runs the advisor
   before the agent processes each user input, injecting the review as a
   `steer`. Existing triggers (`onDone`, `whenStuck`) are unchanged and
   still work alongside it.

## Non-goals

- Do **not** remove or change the existing `onDone`, `whenStuck`, `advisor`
  tool, or `/advise` behavior. They must keep working as before.
- Do **not** change `pi-llama-mb` or `pi-omlx` behavior — they're being
  migrated as-is.
- Do **not** re-implement the `src/` modules from scratch. They already
  exist (recovered from session history) and are the foundation. The work
  is wiring + the `always` field, not rebuilding them.

## Current state of the repo

Already present (recovered, uncommitted):

- `packages/pi-advisor/src/config.mjs` — config validation + resolution
- `packages/pi-advisor/src/diff.mjs` — patch harvest + digest rendering
- `packages/pi-advisor/src/context-policy.mjs` — tail selection + payload
- `packages/pi-advisor/src/summarizer.mjs` — summary pre-call + cache
- `packages/pi-advisor/tests/*.test.mjs` — unit tests
- `packages/pi-advisor/AGENTS.md` — module documentation
- `packages/pi-llama/` — copied from standalone repo, renamed from
  `pi-llama-mb` (the `-mb` is dropped; package `name` was already `pi-llama`)
- `packages/pi-omlx/` — copied from standalone repo

Removed (staged as deletions):
- `packages/pi-thinking-command/` — hknet's, not ours
- `packages/pi-timestamp/` — hknet's, not ours

Still needs doing: see Tasks below.

## Design: context modes

The advisor currently calls `buildTranscript(branch, model)` which sends
the entire conversation. The change is to replace that with
`buildAdvisorPayload(branch, model, cfg, summary, digest)` which assembles
a payload according to `cfg.contextMode`:

| Mode | What gets sent |
|---|---|
| `full` | The entire branch (current behavior; backward compat) |
| `tail` | First user message + last N entries (omitted marker in between) |
| `summary` | A compressed summary of the whole conversation |
| `summary+tail` | Summary + last N entries (the new default) |

The payload is built by `src/context-policy.mjs`. The summary is produced
by `src/summarizer.mjs` (with a rolling cache refreshed every
`summaryRefreshEvery` messages). The diff digest comes from
`src/diff.mjs` (harvested from accumulated `tool_result` events).

A separate system prompt (`ADVISOR_SYSTEM_PROMPT_COMPRESSED`) is used for
non-`full` modes because the advisor is seeing a compressed view and needs
to be told not to assume it sees every tool result.

## Design: the `always` trigger

A new config field `always: boolean` (default `false`). When true, the
`input` event handler runs the advisor *before* the agent processes the
user's message and injects the result as a `steer` so it shapes the
current turn. Guarded by `autoRunning` to prevent re-entrancy.

Precedence: `project > global > env (PI_ADVISOR_ALWAYS) > default(false)`.

This is additive — `onDone` and `whenStuck` keep firing independently.

## Design: config

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

Set `contextMode: "full"` + `stripReasoning: false` to recover byte-compat
with upstream (sends the entire conversation with reasoning intact).

## Tasks

### Monorepo

- [ ] Update root `package.json`:
  - `name`, `description`, `author`, `repository`, `bugs`, `homepage` →
    point at `bhubbb/pi-extensions`
  - `pi.extensions` manifest → declare all 3 entry points:
    `./packages/pi-advisor/advisor.ts`,
    `./packages/pi-llama/src/index.ts`,
    `./packages/pi-omlx/index.ts`
  - `files` array → the 3 package dirs + README
- [ ] Update `tsconfig.json` `include` → drop the deleted packages
- [ ] Update `README.md` → document all 3 packages, attribution to hknet
- [ ] Update `~/.pi/agent/settings.json`:
  - Change package path from `/Users/brendanhubble/Development/pi-extensions`
    to `/Users/brendanhubble/Development/GitHub/pi-extensions`
  - Remove `git:github.com/bhubbb/pi-llama-mb` (now loaded via monorepo)
  - Keep `npm:pi-web-access` and others as-is
- [ ] Verify each package's own `package.json` `pi.extensions` entry point
  is correct

### pi-advisor

- [ ] **advisor.ts**: replace local config functions with imports from
  `src/config.mjs` (remove: `DEFAULT_THINKING`, `DEFAULT_TIMEOUT_MS`,
  `validateAdvisorConfig`, `readConfig`, `writeConfig`,
  `resolveEffectiveConfig`, `envThinkingLevel`, `envTimeoutMs`,
  `EffectiveAdvisorConfig`)
- [ ] **advisor.ts**: add imports of `buildAdvisorPayload`,
  `collectChangesFromEvents`, `renderDigest`, `getSummary`,
  `SummaryCache`, `ChangeEvent` from the src/ modules
- [ ] **advisor.ts**: add `always` + context policy fields to
  `AdvisorConfig` type
- [ ] **advisor.ts**: add `ContextMode` type
- [ ] **advisor.ts**: add `ADVISOR_SYSTEM_PROMPT_COMPRESSED` +
  `systemPromptForMode()`
- [ ] **advisor.ts**: replace `buildTranscript` call in `runAdvisor` with
  `buildAdvisorPayload` using the resolved config
- [ ] **advisor.ts**: add context-policy closure state (`changeEvents`,
  `summaryCache`) and reset on `input`
- [ ] **advisor.ts**: accumulate change events in `tool_result` handler
- [ ] **advisor.ts**: add `always` trigger in `input` event handler
- [ ] **advisor.ts**: wrapper `isDisabled`/`isUnconfigured` that resolve
  config then call the imported versions
- [ ] **config.mjs**: add `always` to `DEFAULTS`, `envAlways()`,
  `validateAdvisorConfig`, `resolveEffectiveConfig`, `writeConfig`
- [ ] Fix the 7 failing tests (test expectations vs recovered module
  output — e.g. `renderEntry` needs `showToolResults` opt, selectTail
  edge cases, digest truncation)
- [ ] Update `packages/pi-advisor/package.json` (`name` →
  `@bhubbb/pi-advisor`, `files` → include `src/`)

### Verification

- [ ] `npm run typecheck` passes (only expected `.mjs` declaration
  warnings remain)
- [ ] `node --test packages/pi-advisor/tests/*.test.mjs` — all pass
- [ ] `pi reload` loads all 3 extensions without errors
- [ ] `pi --list-models` shows llama-cpp models (offline fallback works)
- [ ] `/advisor status` shows resolved config including `always`
- [ ] `/advise` runs and uses `summary+tail` payload by default

### Commit + push

- [ ] One commit for the monorepo consolidation (packages moved, manifest,
  settings, README)
- [ ] One commit for the pi-advisor context policy + always trigger
- [ ] Push to `bhubbb/pi-extensions`

## Attribution

`pi-advisor` is a fork of `hknet/pi-extensions` (EUPL-1.2). Attribution in
README + LICENSE. The upstream `advisor` tool, auto-triggers, and
`/advise` UX are preserved.
