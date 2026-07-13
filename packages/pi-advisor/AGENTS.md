# AGENTS.md — `@bhubbb/pi-advisor`

## Project Overview

This is a fork of `@hk_net/pi-advisor` (from `hknet/pi-extensions`) that replaces
the "send full conversation transcript" behavior with a **configurable context policy**.
Instead of sending the entire conversation to the advisor model, we send:

1. **Last N messages** (configurable tail window)
2. **A generated issue summary** (compressed full-render input → model → ~10 line summary)
3. **A changed-files/diff digest** (patch harvest from `tool_result` events, with `git diff` opt-in)
4. **Reasoning/thinking blocks are stripped by default**

Goal: drastically reduce token waste for local LLM advisors while preserving
hknet's auto-triggers (`onDone`, `whenStuck`) and `/advise` modes.

## Directory Structure

```
packages/pi-advisor/
├── advisor.ts              # Entry point — pi extension, all hooks & commands
├── src/
│   ├── config.mjs          # Config types, validation, resolution (pure Node)
│   ├── diff.mjs            # Patch harvest, branch fallback, git opt-in (pure Node)
│   ├── context-policy.mjs  # Tail selection, rendering, payload assembly (pure Node)
│   └── summarizer.mjs      # Summary pre-call + rolling cache (uses pi-ai)
├── tests/
│   ├── config.test.mjs     # Unit tests for config module
│   ├── diff.test.mjs       # Unit tests for diff module
│   └── context-policy.test.mjs # Unit tests for context-policy module
├── package.json
└── README.md
```

## Key Files

### `advisor.ts` (entry point)
- **No changes to upstream auto-modes**: `onDone`, `whenStuck`, `/advise` all preserved
- **Changes**:
  - Accumulates `tool_result` events in closure state for diff harvest
  - Calls `buildAdvisorPayload()` to assemble context per mode
  - Calls `getSummary()` for summary pre-call
  - Uses `systemPromptForMode()` to select the right system prompt
  - Resets context-policy state on `input` event

### `src/config.mjs` (pure module)
- Validates all config keys (existing + new)
- Resolves precedence: env > project > global > defaults
- Exports `resolveEffectiveConfig()`, `normalizeDiffMode()`, `isDisabled()`, `isUnconfigured()`

### `src/diff.mjs` (pure module)
- `collectChangesFromEvents()` — primary harvest from `tool_result` patch field
- `collectChangesFromBranch()` — fallback from branch entries (toolCall args)
- `collectChangesFromGit()` — opt-in `git diff --stat` / `git diff` (requires `projectTrusted`)
- `renderDigest()` — produces stat or snippets output

### `src/context-policy.mjs` (pure module)
- `renderEntry()` — renders a single branch entry (respects `stripReasoning`, `showToolResults`)
- `selectTail()` — keeps first user msg + last N entries + omitted marker
- `buildAdvisorPayload()` — assembles final transcript per mode (full/tail/summary/summary+tail)
- `oldestFirstTrim()` — context-window overflow handling (same math as upstream)

### `src/summarizer.mjs` (thin I/O module)
- `compressEntriesForSummary()` — compresses full branch to small input
- `getSummary()` — calls model, caches result, handles D3 fallback
- Uses `AbortController` with separate timeout so summary doesn't eat advisor budget

## Configuration

New keys in `advisor.json` (project or global):

```json
{
  "model": "provider/id",
  "thinking": "high",
  "onDone": false,
  "whenStuck": 3,
  "timeoutMs": 120000,

  "contextMode": "summary+tail",     // "full" | "tail" | "summary" | "summary+tail"
  "tailMessages": 10,                // last N messages to include
  "stripReasoning": true,            // drop thinking blocks (always true by default)
  "keepToolResults": "recent",       // "recent" | "all" | "none"
  "diffMode": "stat",                // "none" | "stat" | "snippets" | "git-stat" | "git-snippets"
  "diffMaxChars": 4000,
  "summaryModel": "executor",        // "executor" | "provider/id" | null
  "summaryMaxTokens": 1024,
  "summaryRefreshEvery": 8,          // regenerate summary after N new messages
  "summaryTimeoutMs": 60000
}
```

### Environment Variables

| Variable | Overrides |
|---|---|
| `PI_ADVISOR_MODEL` | model |
| `PI_ADVISOR_EFFORT` | thinking |
| `PI_ADVISOR_TIMEOUT_MS` | timeoutMs |
| `PI_ADVISOR_CONTEXT_MODE` | contextMode |
| `PI_ADVISOR_TAIL` | tailMessages |
| `PI_ADVISOR_STRIP_REASONING` | stripReasoning ("1" or "true") |
| `PI_ADVISOR_DIFF_MODE` | diffMode |
| `PI_ADVISOR_SUMMARY_MODEL` | summaryModel |

### Backward Compatibility

Set `contextMode: "full"` + `stripReasoning: false` to recover byte-compat with upstream.
This sends the entire conversation with reasoning intact.

## Testing

```bash
# Run all unit tests
cd packages/pi-advisor && node --test tests/*.test.mjs

# Run a single test file
cd packages/pi-advisor && node --test tests/config.test.mjs
```

Tests verify:
- Validation rejects invalid keys
- Defaults have correct values
- `git-*` modes downgrade when project untrusted
- Modules load without throwing (no pi context required)
- Each module can be imported and called independently

## Implementation Notes

### D3: Summary Pre-call Failure
If summary generation fails (timeout, auth error, empty response), the payload
degrades gracefully to the `tail` mode shape with a `[summary unavailable]` marker.
The advisor call itself is never aborted.

### Diff Harvest
- **Primary**: Accumulated from `tool_result` event stream (has `details.patch` from pi's edit tool)
- **Fallback**: Reconstructed from branch entries (`toolCall.arguments.edits[].oldText/newText`)
- **Opt-in**: `git diff --stat` / `git diff` in cwd (requires `projectTrusted`, config `diffMode: "git-stat"` or `"git-snippets"`)
- When project is untrusted, `git-stat` and `git-snippets` are downgraded to `stat` and `snippets`

### Tool Results
`keepToolResults: "recent"` only shows tool results whose preceding assistant is in the tail window.
This prevents showing results from old tool calls that are no longer relevant.

### Token Budget
The context-policy module uses the same `reserveTokens/usableTokens/charBudget` math
as upstream for overflow trimming. When the payload exceeds the model's context window,
oldest sections are dropped first.

## Fork Status

- [x] Fork base: `hknet/pi-extensions` (retain auto modes & `/advise` UX)
- [x] Package renamed: `@hknet/pi-advisor` → `@bhubbb/pi-advisor`
- [x] Config module: `src/config.mjs` (validation, resolution, env overrides)
- [x] Diff module: `src/diff.mjs` (patch harvest, branch fallback, git opt-in)
- [x] Context-policy module: `src/context-policy.mjs` (tail, render, payload)
- [x] Summarizer module: `src/summarizer.mjs` (summary pre-call, rolling cache, D3 fallback)
- [x] Wired into `advisor.ts` (closure state, event accumulation, command parsing)
- [x] Unit tests: 69 tests, all passing
- [ ] Update `package.json` files array to include new source structure
- [ ] Update README.md with new config options
- [ ] Test with real advisor runs (local + remote models)
