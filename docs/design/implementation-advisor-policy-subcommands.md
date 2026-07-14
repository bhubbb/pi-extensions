# Implementation: `/advisor` policy subcommand handlers

## Why we're doing this

`/advisor` advertises five policy subcommands in its docstring, autocomplete
list, and `getAdvisorCompletions()` logic — but the command **executor** has
no matching branches for any of them. Typing one of these at the prompt
falls through to the model-spec parser, which fails immediately:

```
Error: Unknown model "summary-model". Use provider/id (run /advisor with no args to pick).
```

Reproducer (with the extension loaded and a configured model):

```
/advisor summary-model anthropic/claude-haiku-4-5
→ Unknown model "summary-model". …
```

Same failure for `context`, `tail`, `diff`, `strip-reasoning`. The
`/advisor ?` help text also fails to list them, and `README.md` never
documented them in the first place.

The config layer (`src/config.ts`) is fully wired: it validates, defaults,
and resolves every one of these keys. The bug is purely in the
`pi.registerCommand("advisor", …)` handler in `advisor.ts` (the same file
already contains the autocomplete logic and the `pickScope` /
`persist` / `showStatus` helpers we need).

## Goals & non-goals

**Goals**

- Add `if (head === …)` branches for the five missing subcommands in the
  `/advisor` handler, mirroring the existing `on-done` / `on-todo` /
  `when-stuck` shape.
- Update the `?` help block to list every supported subcommand so it
  matches the docstring.
- Update `README.md` so the command table reflects what users can type.

**Non-goals**

- No changes to `src/config.ts` (already validates the keys correctly).
- No changes to autocomplete behavior (already correct).
- No new config keys, no new modes, no refactor to a dispatch table —
  the existing pattern of sibling `if` blocks is what we're mirroring.
- No tests of the autocomplete provider (already covered manually; no
  test harness for command handlers exists in this package).

## Scope: the five missing subcommands

| Subcommand        | Config key       | Value type                              | Validation                                       |
|-------------------|------------------|-----------------------------------------|--------------------------------------------------|
| `context`         | `contextMode`    | `full` \| `tail` \| `summary` \| `summary+tail` | whitelist                                       |
| `tail`            | `tailMessages`   | integer ≥ 2                             | integer parse + range                            |
| `diff`            | `diffMode`       | `none` \| `stat` \| `snippets` \| `git-stat` \| `git-snippets` | whitelist (config layer downgrades `git-*` when project untrusted) |
| `strip-reasoning` | `stripReasoning` | `on` \| `off`                           | `on` / `off` only                                |
| `summary-model`   | `summaryModel`   | `executor` \| `off` \| `provider/id`    | sentinel passthrough + `parseSpec` + registry check |

## Per-subcommand design

All five follow the same skeleton already used by `on-done`:

```ts
if (head === "<sub>") {
  const v = tokens[1]?.toLowerCase();
  if (<invalid>) return ctx.ui.notify("Usage: /advisor <sub> …", "error");
  const file = await pickScope();
  if (!file) return;
  persist(file, { <key>: <value> });
  return ctx.ui.notify(`<human confirmation>.`, "info");
}
```

Branch specifics:

### `context <mode>`
```ts
if (head === "context") {
  const v = tokens[1]?.toLowerCase();
  if (!v || !(CONTEXT_MODES as readonly string[]).includes(v))
    return ctx.ui.notify(`Usage: /advisor context <${CONTEXT_MODES.join("|")}>`, "error");
  const file = await pickScope();
  if (!file) return;
  persist(file, { contextMode: v as ContextMode });
  return ctx.ui.notify(`Context mode: ${v}.`, "info");
}
```

### `tail <N>`
```ts
if (head === "tail") {
  const n = Number(tokens[1]);
  if (!Number.isInteger(n) || n < 2)
    return ctx.ui.notify("Usage: /advisor tail <N>  (integer >= 2)", "error");
  const file = await pickScope();
  if (!file) return;
  persist(file, { tailMessages: n });
  return ctx.ui.notify(`Tail messages: ${n}.`, "info");
}
```

### `diff <mode>`
```ts
if (head === "diff") {
  const v = tokens[1]?.toLowerCase();
  if (!v || !(DIFF_MODES as readonly string[]).includes(v))
    return ctx.ui.notify(`Usage: /advisor diff <${DIFF_MODES.join("|")}>`, "error");
  const file = await pickScope();
  if (!file) return;
  persist(file, { diffMode: v as DiffMode });
  return ctx.ui.notify(`Diff mode: ${v}.`, "info");
}
```

### `strip-reasoning <on|off>`
```ts
if (head === "strip-reasoning") {
  const v = tokens[1]?.toLowerCase();
  if (v !== "on" && v !== "off")
    return ctx.ui.notify("Usage: /advisor strip-reasoning on|off", "error");
  const file = await pickScope();
  if (!file) return;
  persist(file, { stripReasoning: v === "on" });
  return ctx.ui.notify(`Strip reasoning: ${v}.`, "info");
}
```

### `summary-model <executor|off|provider/id>`
Three valid forms. `executor` and `off` are sentinels — they bypass the
registry check. `provider/id` must resolve to a configured model.

```ts
if (head === "summary-model") {
  const v = tokens[1];
  if (!v) return ctx.ui.notify("Usage: /advisor summary-model executor|off|<provider/id>", "error");
  let resolved: string | null;
  if (v === "executor") resolved = "executor";
  else if (v === "off") resolved = null;
  else {
    const parsed = parseSpec(v);
    if (!parsed) return ctx.ui.notify(`Unknown summary model "${v}". Use "executor", "off", or provider/id.`, "error");
    if (!ctx.modelRegistry.find(parsed.provider, parsed.id))
      return ctx.ui.notify(`Unknown summary model "${v}" (not in registry).`, "error");
    resolved = v;
  }
  const file = await pickScope();
  if (!file) return;
  persist(file, { summaryModel: resolved });
  return ctx.ui.notify(`Summary model: ${resolved ?? "off"}.`, "info");
}
```

Note: `persist` calls `writeConfig` which already strips `undefined` and
merges with the existing file. Storing `null` for `summaryModel` is the
documented "off" state (`validateAdvisorConfig` normalizes both `null`
and the string `"off"` to `clean.summaryModel = null`).

## Implementation plan

Single file changed: `packages/pi-advisor/advisor.ts`.

1. **Insert five new `if (head === "…")` blocks** in the
   `pi.registerCommand("advisor", …)` handler, between the existing
   `when-stuck` block (≈line 1019) and the `// Model setters.` comment
   (≈line 1023). Order matches the autocomplete item order:
   `context`, `tail`, `diff`, `strip-reasoning`, `summary-model`.

2. **Update the `?` help block** (≈line 882 for `/advise`, ≈line 947 for
   `/advisor`) so `/advisor ?` lists the policy subcommands with their
   value syntax. The current block only documents the upstream commands.

3. **Update `README.md`** — the Commands table currently lists the
   upstream subcommands only. Add rows for `context`, `tail`, `diff`,
   `strip-reasoning`, `summary-model`, mirroring the language already
   used in the file's docstring.

No changes to `src/config.ts`, `src/summarizer.ts`, `src/context-policy.ts`,
`src/diff.ts`, or any tests.

## Help text & README surface

The help text inside `advisor.ts` (lines 947–958) currently reads:

```
/advisor                      — open model picker dialog, set thinking
/advisor <provider/id> [level] — set model directly → choose scope
/advisor none / default        — disable / clear a scope → choose scope
/advisor on-done on|off        — toggle auto-review on finish → choose scope
/advisor on-todo on|off        — toggle auto-review on todo completion → choose scope
/advisor when-stuck off|<N>    — trigger advisor on N consecutive errors or N repeated identical tool calls → choose scope
/advisor status                — show resolved configuration
/advisor ?                     — show this help
```

Append:

```
/advisor context <full|tail|summary|summary+tail>  — set context mode → choose scope
/advisor tail <N>                                  — set tail message count (>=2) → choose scope
/advisor diff <none|stat|snippets|git-stat|git-snippets>  — set diff mode → choose scope
/advisor strip-reasoning on|off                    — toggle reasoning stripping → choose scope
/advisor summary-model executor|off|<provider/id>  — set summary model → choose scope
```

`README.md` Commands table gets the same five rows added in the same order.
The existing "Configuration" section already documents the keys (in the
`AGENTS.md`); it just needs cross-reference parity in the README.

## Testing strategy

There is no command-handler test harness in this package — tests are
config-validation only (`tests/config.test.mjs`). Adding a fake-pi harness
for slash-command tests is out of scope.

**Manual verification matrix** (run inside pi after the change):

| Command                                              | Expected                                                                  |
|------------------------------------------------------|---------------------------------------------------------------------------|
| `/advisor context summary` → project                 | persists `contextMode: "summary"`; `/advisor status` shows it              |
| `/advisor context bogus`                             | `Usage: /advisor context <…>` error toast, no write                       |
| `/advisor tail 8` → project                          | persists `tailMessages: 8`; `/advisor status` reflects                    |
| `/advisor tail 1`                                    | error: integer >= 2                                                       |
| `/advisor diff snippets` → project                   | persists `diffMode: "snippets"`                                           |
| `/advisor strip-reasoning off` → project             | persists `stripReasoning: false`                                          |
| `/advisor strip-reasoning maybe`                     | error: on/off                                                             |
| `/advisor summary-model executor` → project          | persists `summaryModel: "executor"`                                       |
| `/advisor summary-model off` → project               | persists `summaryModel: null` (config writes literal `null`)              |
| `/advisor summary-model anthropic/claude-haiku-4-5` → project | persists `summaryModel: "anthropic/claude-haiku-4-5"` if registered |
| `/advisor summary-model bogus/nope`                  | error: not in registry                                                    |
| `/advisor ?`                                         | lists all five policy subcommands                                         |
| `/advisor <TAB>` autocomplete                        | still offers the five policy subcommands (unchanged)                      |

**Automated regression checks**:

- `node --test tests/config.test.mjs` — should still pass unchanged
  (the new handlers only call `writeConfig` with keys the validator
  already accepts).
- The autocomplete `tests/` directory has no coverage for
  `getAdvisorCompletions`. Not adding one — the manual matrix covers it
  and the function isn't being modified.

## Risks & edge cases

1. **`writeConfig` JSON shape.** `writeConfig` only emits known keys
   and preserves undefined values as omits. Passing `{ summaryModel:
   null }` writes the literal `null`, which the validator then maps to
   `clean.summaryModel = null` (i.e., "off"). This is the correct
   behavior and matches what `/advisor summary-model off` should do.
   Verified by reading `writeConfig` and `validateAdvisorConfig` in
   `src/config.ts`.

2. **Git diff modes in untrusted projects.** No special-casing needed at
   the command layer — `resolveEffectiveConfig` downgrades `git-*` to
   non-git when `projectTrusted` is false, and `/advisor status`
   surfaces the effective mode. If we ever wanted the handler to refuse
   `git-*` upfront in untrusted projects, that's a follow-up; current
   behavior (silent downgrade + warning) matches the rest of the
   extension.

3. **`summary-model` with the currently-running executor model.**
   `executor` is always valid because it doesn't depend on the registry.
   The flag passes through unchanged. No risk.

4. **Cancel-mid-flow.** Every branch uses the existing `pickScope()`
   helper, which already returns `undefined` when the user cancels the
   scope picker. Handlers check `if (!file) return;` and exit cleanly
   with no write — consistent with `on-done`.

5. **Order of validation vs. registry refresh.** The existing model
   setter calls `refreshAvailableModels(ctx)` near the top of the
   handler (before the first `head ===` branch). The new branches rely
   on that same refresh for `summary-model`'s registry check. No
   additional refresh needed.

## Bonus fix: `summaryModel: null` resolution bug

While implementing the tests, a pre-existing bug was found: `resolveEffectiveConfig`
used `??` (nullish coalescing) to chain `summaryModel` across env → project →
global → default. This meant `summaryModel: null` (the "off" state) was treated
as "not set" and fell through to global/default.

**Fix:** Replace the `??` chain for `summaryModel` with an explicit `!== undefined`
check in both `config.ts` and `config.mjs`, so `null` is treated as a valid
"off" value. Captured the env value once in an IIFE to avoid double-calling
`envSummaryModel()`.

## Open questions

None blocking. Two minor follow-ups deferred:

- **`/advise ?`** — same kind of help-text drift may exist in the
  `/advise` command. Out of scope for this fix; file a separate issue
  if noticed.
- **Command-handler test harness** — would be valuable as a follow-up
  but is a bigger lift (needs a fake `ExtensionContext`). Out of scope.
