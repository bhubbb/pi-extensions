# Implementation: pi-advisor `onTodoDone` trigger

## Why we're doing this

The advisor already has two opt-in deterministic triggers — `onDone`
(review when the agent finishes a task) and `whenStuck` (review after N
consecutive errors or N repeated identical tool calls). Both default
**off**, both are configured per project/global, and both auto-consult the
reviewer and inject the feedback into the conversation.

We want a third opt-in trigger, **`onTodoDone`**, that fires the advisor
the moment the agent marks a todo as completed. This catches "I'm done
with this step" claims at the exact point they're made — before the agent
moves on to the next todo or declares the whole task finished. It is the
same shape as the other two: a boolean, default off, configurable via
`advisor.json` and a `/advisor on-todo on|off` command, with an env
override. It does **nothing** unless a reviewer model is configured.

**Critical constraint:** `onDone`, `whenStuck`, the `advisor` tool,
`/advise`, and all context-policy modes must keep working unchanged. The
new trigger is purely additive.

## The todo tool problem (read this first)

Stock pi (0.80.x) ships **no built-in `todo` tool** in
`dist/core/tools`. The only todo tool in the pi tree is the example
extension `examples/extensions/todo.ts`, which uses actions
`list | add | toggle | clear` and a boolean `done` flag on each item.
The richer todo tool the agent harness exposes (actions
`create | update | list | get | delete`, with a `status` field of
`pending | in_progress | completed | deleted`) is **not** in this repo.

The advisor detects todo completion by listening to `tool_result` events
and inspecting `event.toolName` plus `event.input`. That only works if a
`todo` tool is actually loaded in the session **and** the advisor knows
its input/result shape.

**Decision for this plan:** the advisor must support **both** known
shapes, because either tool may be loaded:

- **Rich status tool (preferred):** completion = `event.input.action ===
  "update"` **and** `event.input.status === "completed"`. The result
  details may also carry the new status; prefer the input when present,
  fall back to `event.details.status === "completed"`.
- **Example toggle tool:** completion = `event.input.action ===
  "toggle"` **and** the toggled item ended up done. The result details
  contain the item; treat completion as `event.details.done === true`
  (fall back to parsing the result text only if details are absent).

The detection helper must try the rich shape first, then the toggle
shape, and only return true for a genuine transition **to** completed
(not un-completing a previously done item). For the toggle tool, compare
the toggled item's `done` in the result: true = completed, false =
un-completed (do not trigger).

**Optional prerequisite (recommended):** bring a `todo` tool into this
repo as a package (for example `packages/pi-todo`) or copy the example
into `packages/pi-advisor` as a sibling extension, so the shape the
advisor detects against is stable and tested. This plan does **not**
require that — the advisor changes are independent and degrade silently
(no `todo` tool loaded ⇒ no `tool_result` with `toolName === "todo"` ⇒
trigger never fires). But if the repo adopts the rich todo tool later,
the advisor already supports it.

## What already exists (do not rebuild)

### Triggers as the template to copy

`onDone` and `whenStuck` are the exact pattern. Each is:

1. A field on the `AdvisorConfig` type in `src/config.ts` (and mirrored
   in `src/config.mjs`).
2. Validated in `validateAdvisorConfig` (type check + warn on invalid).
3. Resolved in `resolveEffectiveConfig` with precedence
   `env > project > global > default`, and returned on the
   `EffectiveAdvisorConfig` object.
4. Exposed via the `effectiveTriggers(cwd, projectTrusted)` accessor,
   which currently returns `{ onDone, whenStuck }`.
5. Listed in the `writeConfig` known-keys array so `/advisor …` commands
   persist it.
6. Wired in `advisor.ts`:
   - `whenStuck` lives inside the existing `pi.on("tool_result", …)`
     handler (the same handler that accumulates `changeEvents`).
   - `onDone` lives in `pi.on("agent_end", …)`.
   - Both call `runAutomaticReview(ctx, buildMessage, deliverAs)`.
   - Both are guarded by `isDisabled`, `isUnconfigured`, and the
     `autoRunning` re-entrancy flag.
   - `onDone` additionally sets `autoReviewedThisRound = true` so it
     fires at most once per user prompt.
7. Exposed as a `/advisor <subcommand>` handler with a `pickScope` +
   `persist` step, a notification, and a entry in
   `ADVISOR_FIRST_TOKEN_ITEMS` plus a branch in
   `getAdvisorCompletions`.
8. Shown in `showStatus` inside the `/advisor status` output.
9. Documented in the header comment block at the top of `advisor.ts`
   and in `README.md`.
10. Tested in `tests/config.test.mjs` (validation + resolution).

### The `tool_result` handler (where the new trigger lives)

The existing `pi.on("tool_result", async (event, ctx) => { … })`
handler in `advisorExtension(pi)` already:

- Accumulates `changeEvents` for edit/write/bash (top of the handler).
- Resolves `projectTrusted` and `whenStuck` via `effectiveTriggers`.
- Bails out early when disabled / unconfigured / `whenStuck <= 0` /
  `autoRunning` / `event.toolName === "advisor"`.
- Tracks `stuckErrors`, `loopCount`, `lastFingerprint` and fires
  `runAutomaticReview(…, "steer")` on threshold.

The new `onTodoDone` branch goes in this same handler, **after** the
change-event accumulation and **before** (or alongside) the
`whenStuck` early-return. It must not be gated by `whenStuck <= 0`,
because `onTodoDone` is an independent trigger — read both fields from
`effectiveTriggers` and check each separately.

### `runAutomaticReview` (reuse, do not change)

`runAutomaticReview(ctx, buildMessage, deliverAs)` sets `autoRunning =
true`, calls `runAdvisor`, and on success calls
`pi.sendUserMessage(buildMessage(text), { deliverAs })`. It swallows
errors so an auto-trigger never breaks the turn. The new trigger calls
this exact function with `deliverAs: "steer"` (same as `whenStuck`) so
the advice reaches the agent immediately without waiting for the turn
to end.

## What we're changing

### Change 1: `src/config.ts` — add the `onTodoDone` field

- Add `onTodoDone?: boolean` to the `AdvisorConfig` type, next to
  `onDone` and `whenStuck`.
- Add `onTodoDone: false` to `DEFAULTS` is **not** needed (booleans
  default via `?? false` like `onDone` does), but for consistency with
  `onDone` just resolve it as `project.onTodoDone ?? global.onTodoDone ??
  false` — no `DEFAULTS` entry required. Match exactly how `onDone` is
  handled.
- In `validateAdvisorConfig`, add a block copied from the `onDone`
  block: if `input.onTodoDone !== undefined`, accept a boolean, else
  warn `'"onTodoDone" must be a boolean'`.
- Add `envOnTodoDone()` reading `PI_ADVISOR_ON_TODO_DONE` (return
  `true` for `"1"`, `false` for `"0"`, `undefined` otherwise) — same
  shape as the other env helpers.
- In `resolveEffectiveConfig`, add
  `onTodoDone: envOnTodoDone() ?? project.onTodoDone ?? global.onTodoDone ?? false`
  to the returned object, and add `onTodoDone: boolean` to the
  `EffectiveAdvisorConfig` type.
- In `effectiveTriggers`, change the return to
  `{ onDone, whenStuck, onTodoDone }` so callers get all three in one
  call (the `tool_result` and `agent_end` handlers already destructure
  from this).
- In the `writeConfig` known-keys array, add `"onTodoDone"` so
  `/advisor on-todo` persists it.

### Change 2: `src/config.mjs` — mirror Change 1 exactly

The `.mjs` file is the one the tests import. Apply the same additions
(type-free, but same fields, same validation, same env helper, same
resolution line, same `writeConfig` key, same `effectiveTriggers`
return). Keep the two files in lockstep — the existing design doc
treats them as parallel.

### Change 3: `advisor.ts` — add the `onTodoDone` trigger branch

Inside the existing `pi.on("tool_result", …)` handler, after the
`changeEvents` accumulation and **after** resolving `projectTrusted`
and the triggers from `effectiveTriggers`, add a new branch. It must:

1. Read `onTodoDone` from the destructured triggers (the existing
   destructure `{ whenStuck }` becomes `{ whenStuck, onTodoDone }`).
2. Bail out unless `onTodoDone` is true **and** not disabled, not
   unconfigured, not `autoRunning`, and `event.toolName !== "advisor"`.
   (The `toolName === "advisor"` guard already covers the whole
   handler; keep it.)
3. Bail out unless `event.toolName === "todo"`.
4. Call a new pure detection helper (see Change 4) with `event.input`
   and `event.details` to decide whether this result represents a
   transition **to** completed. If not, return.
5. Call `runAutomaticReview(ctx, buildMessage, "steer")` where
   `buildMessage` names what just happened, e.g. a string like
   `"The agent marked a todo as completed. A reviewer model was
   consulted:\n\n${text}\n\nAddress any valid issues before moving on."`
   Use the same template style as the `whenStuck` messages.

**Do not set `autoReviewedThisRound`.** That flag belongs to `onDone`
(one review per user prompt). `onTodoDone` may fire several times per
prompt (one per completed todo) and should not suppress the final
`onDone` review. If spam becomes a problem later, add a per-round cap
as a separate change — not here.

**Ordering note:** place this branch so it runs even when `whenStuck`
is off. The cleanest split is to compute the disabled/unconfigured/
autoRunning guards once at the top, then handle `onTodoDone` and
`whenStuck` as two independent `if` blocks. Do not piggy-back on the
existing `whenStuck` early-return.

### Change 4: `advisor.ts` — add a todo-completion detection helper

Add a small pure function (no pi imports, no side effects) that takes
the tool `input` and the result `details` and returns a boolean
`isTodoCompletion(input, details)`. It encodes the two shapes from the
"todo tool problem" section:

- If `input.action === "update"` and `input.status === "completed"`
  → true. (Rich tool.)
- Else if `input.action === "update"` and `details?.status ===
  "completed"` → true. (Result carries the new status.)
- Else if `input.action === "toggle"` and `details?.done === true`
  → true. (Example tool, toggled to done.)
- Otherwise → false.

Never throw on unexpected shapes — return false. Keep it strict: only
the exact action strings above count, so a future `delete` action or a
toggle that un-completes an item does not fire the trigger.

### Change 5: `advisor.ts` — add the `/advisor on-todo` command

In the `/advisor` command handler, right after the existing
`if (head === "on-done") { … }` block, add a sibling
`if (head === "on-todo") { … }` block. It is identical in shape:

- Parse `tokens[1]` as `on` or `off`; notify usage error otherwise.
- `pickScope()` → get the config file.
- `persist(file, { onTodoDone: v === "on" })`.
- Notify `Auto-review on todo completion: ${v}.`

### Change 6: `advisor.ts` — completions for `on-todo`

- Add an entry to `ADVISOR_FIRST_TOKEN_ITEMS`:
  `{ value: "on-todo", label: "on-todo", description: "Toggle automatic review when the agent completes a todo" }`,
  placed next to the `on-done` entry.
- In `getAdvisorCompletions`, add a branch matching the `on-done`
  branch: when `head === "on-todo"`, filter `ON_OFF` by the current
  prefix and return items whose `value` is `${tokens[0]} ${v}`.

### Change 7: `advisor.ts` — show `on-todo` in status

In `showStatus` (inside `/advisor status`), extend the status line to
include `on-todo ${onTodoDone ? "on" : "off"}` alongside the existing
`on-done` and `when-stuck` text. Pull `onTodoDone` from
`effectiveTriggers(cwd, projectTrusted)` (same call that already
produces `t`).

### Change 8: `advisor.ts` — update the header comment + help text

- In the top-of-file config comment block, add
  `"onTodoDone": true,  // auto-review when the agent completes a todo`
  next to the `onDone` line.
- In the `Commands` comment list, add
  `/advisor on-todo on|off  — toggle auto-review on todo completion → choose scope`.
- In the `?` help text inside the `/advisor` handler, add a matching
  line so `/advisor ?` lists it.

### Change 9: `README.md` — document the new trigger

- In the `Configuration` JSON block, add `"onTodoDone": false` with a
  comment, next to `onDone`.
- In the `Commands` table, add a row for
  `/advisor on-todo on|off`.
- In the `Automatic triggers` section, add a third bullet for
  `onTodoDone` describing when it fires (on a `tool_result` whose `todo`
  tool call transitions an item to completed), that it delivers advice
  as a steering message, and that it requires a reviewer model.
- In `Privacy & security`, note that `onTodoDone` is off by default and
  sends the configured context (not the full transcript) only when a
  reviewer model is configured — same wording as the existing
  auto-trigger notes.

### Change 10: tests — cover the new field and the detector

In `tests/config.test.mjs`:

- Add a case to the "accepts valid existing keys" test: pass
  `onTodoDone: true` and assert it round-trips.
- Add a case asserting `validateAdvisorConfig` rejects a non-boolean
  `onTodoDone` (warns, returns `undefined`).
- Add a case asserting `resolveEffectiveConfig` reads `onTodoDone` from
  project over global, and that `effectiveTriggers` returns
  `onTodoDone` alongside `onDone`/`whenStuck`.
- Add a case for the `PI_ADVISOR_ON_TODO_DONE` env override (`"1"` →
  true, `"0"` → false, unset → falls back to config).

Add a new test file `tests/todo-trigger.test.mjs` (or extend an
existing one) that exercises the **detection helper only** (pure
function, no pi needed):

- Rich tool: `action: "update"`, `status: "completed"` → true.
- Rich tool: `action: "update"`, `status: "in_progress"` → false.
- Rich tool: `action: "update"`, no input status but
  `details.status === "completed"` → true.
- Toggle tool: `action: "toggle"`, `details.done === true` → true.
- Toggle tool: `action: "toggle"`, `details.done === false` → false.
- Unrelated action (`list`, `create`, `delete`, `clear`) → false.
- Unexpected/missing input → false, no throw.

Export the detection helper from `advisor.ts` (named export) so the
test can import it without spinning up the extension.

## Config reference

New key in `advisor.json` (optional, backward compatible):

```json
{
  "onTodoDone": false
}
```

Precedence: `env (PI_ADVISOR_ON_TODO_DONE) > project > global > false`.

`onTodoDone` is independent of `onDone` and `whenStuck`; all three can
be on at once. When `onTodoDone` fires, it does not suppress a later
`onDone` review for the same prompt.

## Tasks

- [ ] **src/config.ts**: add `onTodoDone?: boolean` to `AdvisorConfig`
- [ ] **src/config.ts**: validate `onTodoDone` in
  `validateAdvisorConfig` (boolean, warn on invalid)
- [ ] **src/config.ts**: add `envOnTodoDone()` reading
  `PI_ADVISOR_ON_TODO_DONE`
- [ ] **src/config.ts**: add `onTodoDone` to `EffectiveAdvisorConfig`
  and to the `resolveEffectiveConfig` return (env > project > global >
  false)
- [ ] **src/config.ts**: add `onTodoDone` to the `effectiveTriggers`
  return object
- [ ] **src/config.ts**: add `"onTodoDone"` to the `writeConfig`
  known-keys array
- [ ] **src/config.mjs**: mirror every change above exactly
- [ ] **advisor.ts**: add the pure `isTodoCompletion(input, details)`
  detection helper and export it
- [ ] **advisor.ts**: in the `tool_result` handler, destructure
  `onTodoDone` from `effectiveTriggers` and add the independent
  `onTodoDone` branch calling `runAutomaticReview(…, "steer")`
- [ ] **advisor.ts**: add the `/advisor on-todo on|off` command branch
- [ ] **advisor.ts**: add the `on-todo` entry to
  `ADVISOR_FIRST_TOKEN_ITEMS` and a completion branch in
  `getAdvisorCompletions`
- [ ] **advisor.ts**: add `on-todo` to `showStatus` output
- [ ] **advisor.ts**: update the header config comment, the Commands
  comment, and the `/advisor ?` help text
- [ ] **README.md**: add `onTodoDone` to the config block, the Commands
  table, the Automatic triggers section, and the Privacy notes
- [ ] **tests/config.test.mjs**: add validation, resolution, env, and
  `effectiveTriggers` cases for `onTodoDone`
- [ ] **tests/todo-trigger.test.mjs**: add cases for
  `isTodoCompletion` covering rich, toggle, unrelated, and missing
  shapes
- [ ] `npm run typecheck` passes
- [ ] `node --test packages/pi-advisor/tests/*.test.mjs` — all pass
- [ ] `pi reload` loads without errors; `/advisor status` shows
  `on-todo off` by default and `on-todo on` after
  `/advisor on-todo on`
- [ ] With a reviewer model configured and `onTodoDone` on, completing
  a todo via the loaded `todo` tool triggers one advisor review
  delivered as a steering message; un-completing a todo does not
- [ ] Confirm `onDone` and `whenStuck` still behave exactly as before
- [ ] Commit + push

## Optional follow-up (not part of this plan)

- Bring a `todo` tool into the repo as `packages/pi-todo` (or copy the
  example extension) so the detection shape is owned and tested here.
- If `onTodoDone` fires too often in practice, add a per-round cap
  (e.g. at most N todo-completion reviews per user prompt) as a
  separate config field — do not bundle it into this change.

## Attribution

`pi-advisor` is a fork of `hknet/pi-extensions` (EUPL-1.2). The existing
`advisor` tool, auto-triggers, `/advise` UX, and context policy are
preserved. This change adds one opt-in trigger that mirrors `onDone` and
`whenStuck`.
