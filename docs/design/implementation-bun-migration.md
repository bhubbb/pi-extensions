# Implementation: Migrate the whole monorepo to Bun

## Why we're doing this

The repo currently runs **two test ecosystems in parallel** and they don't
talk to each other:

- `pi-advisor` runs on `node --test` against hand-compiled `tests/*.test.mjs`
  (a `tsc -p tsconfig.test.json` step + a Node ESM runner).
- `pi-llama` and `pi-llama-stats` run on `bun test` against source
  `tests/*.test.ts` using `bun:test` and `Bun.spawn` (no compile step).
- `pi-omlx` has no tests.

`npm test` only exercises the first ecosystem, and even that one is broken
right now (69 tsc errors — see `docs/reports/` once written, or the previous
failure analysis). Meanwhile `bun test packages/pi-llama` passes 60/60 and
`bun test packages/pi-llama-stats` passes 58/58 today. The Bun ecosystem is
already the more reliable half.

Goal: **one runner, one command, one source-of-truth test format.** Bun
wins because (a) it transpiles `.ts` on the fly so we can delete the
`tsc + .tmp-test/` build step, (b) it already runs the largest two test
suites green, (c) Bun ≥ 1.1 supports the same ESM/Node APIs the source uses.

**Scope:** this is a **full port**, not a mechanical import-path swap.
The pi-advisor `.mjs` "shadow" source files have **diverged** from their
`.ts` counterparts (different exports, different function signatures,
functions that exist in one but not the other). The tests currently
exercise `.mjs`-specific behavior. Pointing them at the `.ts` sources
requires reconciling those gaps first. See **"Divergence map"** below.

**Package scope guard:** only `pi-advisor` needs this work. `pi-llama`
and `pi-llama-stats` are already pure `.ts` and run green under `bun test`
(118 tests confirmed). `pi-omlx` has no tests and no tsconfig. CI
workflows already use `npx oxfmt` / `npx oxlint`, which keep working
unchanged. Runtime behaviour, `pi.extensions` manifest entries, and peer
dependencies are untouched.

## Current state — what to delete, what to keep

### Delete

| Path | Why |
|---|---|
| `tsconfig.test.json` | tsc compile gate is replaced by Bun's on-the-fly transpile. |
| `packages/pi-advisor/tests/*.test.mjs` (5 files) | Replaced by `*.test.ts` using `bun:test`. |
| `packages/pi-advisor/src/*.mjs` (4 files: `config.mjs`, `diff.mjs`, `context-policy.mjs`, `summarizer.mjs`) | Diverged shadows of the `.ts` sources. Only the `.mjs`-based tests import them; `advisor.ts` already imports the `.ts` sources directly. |
| `.tmp-test/` (build output dir) | No longer produced. Already in `.gitignore`. |
| `package-lock.json` | Replaced by `bun.lock`. |
| The `typecheck` and `test` entries in the root `package.json` `scripts` | Replaced by `bun test` + `bun run typecheck` (Bun's built-in transpile doesn't enforce types — we still need `tsc --noEmit` for that). |

### Keep

- All `.ts` source under `packages/*/src/` and `packages/pi-advisor/advisor.ts`.
- `packages/pi-llama/tsconfig.json` and `packages/pi-llama-stats/tsconfig.json` (each package keeps its own tsc config; only the test-include differs — see step 5).
- `packages/pi-llama/.github/workflows/ci.yml` and `packages/pi-omlx/.github/workflows/ci.yml` (lint/format only, no tests).
- `package.json` root dependencies, workspaces, `pi.extensions` manifest.
- All design docs that say `bun test packages/pi-llama` etc. (they already match the new state).

## Divergence map — why this is a port, not a swap

The pi-advisor `.mjs` files were written as "Node-runnable shadows" of the
`.ts` sources so that `node --test` could import them. Over time they
diverged. Below is the full audit (performed 2026-07-14). The tests import
from the `.mjs` files; the new `.test.ts` files will import from the `.ts`
sources, so every gap below **must be reconciled before or during the test
rewrite**.

### `config.ts` vs `config.mjs`

| Symbol | `.mjs` | `.ts` | Action |
|---|---|---|---|
| `normalizeDiffMode(mode, projectTrusted)` → `{ effectiveMode, warning? }` | ✅ exported (line 430) | ❌ **missing** — the downgrade logic exists only as a local closure `downgradeDiffMode` inside `resolveEffectiveConfig` (line 320) | **Port it.** Add a standalone `export function normalizeDiffMode(mode: DiffMode, projectTrusted: boolean): { effectiveMode: DiffMode; warning?: string }` to `config.ts`, refactoring `resolveEffectiveConfig` to call it. The `.mjs` implementation is the reference. |
| `isDisabled(cfg)` / `isUnconfigured(cfg)` | ✅ take a config object | `isDisabled(cwd, projectTrusted)` / `isUnconfigured(cwd, projectTrusted)` — different signature | **No action.** `advisor.ts` already imports the `.ts` signatures. Tests don't import these. Delete the `.mjs` versions. |
| `readConfig`, `DEFAULT_TIMEOUT_MS` | ✅ exported | private (module-local) | **No action.** Tests don't import these. |
| `effectiveModelSpec`, `effectiveThinking`, `effectiveTriggers`, `effectiveTimeoutMs`, `contextProjectTrusted` | ❌ not in `.mjs` | ✅ in `.ts` | **No action.** These are `.ts`-only additions; no test impact. |

### `context-policy.ts` vs `context-policy.mjs`

| Symbol | `.mjs` | `.ts` | Action |
|---|---|---|---|
| `renderEntry(entry, opts)` | ✅ exported | defined internally (line 48) but **not exported** | **Add `export`** to the `function renderEntry` declaration. |
| `truncate(text, maxChars)` | ✅ exported | defined internally (line 24) but **not exported** | **Add `export`** to the `function truncate` declaration. |
| `selectTail`, `buildAdvisorPayload` | ✅ | ✅ exported | No action. |

### `diff.ts` vs `diff.mjs`

| Symbol | `.mjs` | `.ts` | Action |
|---|---|---|---|
| `countPatchChanges`, `isVerificationCommand`, `collectChangesFromEvents`, `collectChangesFromBranch`, `renderDigest` | ✅ | ✅ exported, same signatures | **No action.** Tests should port cleanly. |
| `renderStatDigest`, `renderSnippetsDigest`, `collectChangesFromGit` | ✅ exported | ❌ not exported (internal or refactored into `renderDigest` / `tryGitDiff`) | **No action.** Tests don't import these. |
| `tryGitDiff` | ❌ (called `collectChangesFromGit`) | ✅ | **No action.** Tests don't import this. |

### `summarizer.ts` vs `summarizer.mjs`

| Symbol | `.mjs` | `.ts` | Action |
|---|---|---|---|
| `getSummary` | ✅ | ✅ exported | **No action.** No test imports from summarizer. |
| `SummarySource`, `SummaryCache` (as object) | ✅ | `.ts` has `SummaryCache` as a type only | **No action.** No test imports these. Delete the `.mjs` shadow. |

### `advisor.ts`

`advisor.ts` already imports from `.ts` sources directly (lines 104–110):
`./src/config.ts`, `./src/context-policy.ts`, `./src/diff.ts`,
`./src/summarizer.ts`. It does **not** import any `.mjs` file. The `.mjs`
shadows are used exclusively by the `.test.mjs` files. Deleting them is
safe for runtime.

## How the new pipeline looks

```
bun install                 # writes bun.lock
bun test                    # runs all *.test.ts under packages/*/tests/
bun run typecheck           # tsc --noEmit across all packages (see step 5)
```

`bun test` walks the workspace and picks up every `*.test.ts` under any
`tests/` directory. No glob, no build step, no `tsconfig.test.json`.

## What changes, file by file

### 1. Root `package.json`

Replace `scripts`:

```jsonc
{
  "scripts": {
    "test": "bun test",
    "typecheck": "bun run typecheck:advisor && bun run typecheck:llama && bun run typecheck:llama-stats",
    "typecheck:advisor": "tsc -p packages/pi-advisor/tsconfig.json",
    "typecheck:llama": "tsc -p packages/pi-llama/tsconfig.json",
    "typecheck:llama-stats": "tsc -p packages/pi-llama-stats/tsconfig.json"
  }
}
```

Also add `@types/bun` to root `devDependencies` (for IDE support of
`bun:test` types in test files and any `Bun.*` usage in source):

```jsonc
"@types/bun": "^1.1.0",
```

Notes:
- Each per-package `typecheck:*` requires that package to ship a
  `tsconfig.json`. Today only `pi-llama` and `pi-llama-stats` do; pi-advisor
  does not (it relies on the root `tsconfig.json`). Step 4 covers adding it.
- `pi-omlx` has no tsconfig and no tests — exclude until either appears.
  The hardcoded list is deliberate scope; new packages must be added to
  the `typecheck` script manually (acceptable tech debt until pi-omlx
  gets a tsconfig).

### 2. `tsconfig.test.json`

Delete. Bun does the transpile.

### 3. Reconcile source gaps (preconditions for the test rewrite)

Before porting any test, fix the three `.ts` source gaps identified in
the **Divergence map**. These are the blockers that make the tests
import-unresolvable as-is:

**3a. `config.ts` — port `normalizeDiffMode`**

The `.ts` source has the downgrade logic only as a local closure
(`downgradeDiffMode`) inside `resolveEffectiveConfig`. Extract it into a
standalone exported function so the test (and `advisor.ts`, if desired)
can call it directly. Reference implementation (from `config.mjs` line
430, typed):

```ts
export function normalizeDiffMode(
  mode: DiffMode,
  projectTrusted: boolean,
): { effectiveMode: DiffMode; warning?: string } {
  if (!projectTrusted && (mode === "git-stat" || mode === "git-snippets")) {
    const fallback: DiffMode = mode === "git-stat" ? "stat" : "snippets";
    return {
      effectiveMode: fallback,
      warning: `[pi-advisor] downgraded diffMode "${mode}" → "${fallback}" (project not trusted)`,
    };
  }
  return { effectiveMode: mode };
}
```

Then refactor `resolveEffectiveConfig`'s local `downgradeDiffMode` closure
to delegate to `normalizeDiffMode(...).effectiveMode` (keep the warning
suppressed at the resolve call site — it's only surfaced when the user
sets the mode directly).

**3b. `context-policy.ts` — export `renderEntry` and `truncate`**

Both functions already exist (lines 48 and 24). Add the `export` keyword
to each declaration. No body changes.

**3c. Verify `diff.ts` signatures**

The five functions the `diff.test` suite imports
(`countPatchChanges`, `isVerificationCommand`,
`collectChangesFromEvents`, `collectChangesFromBranch`, `renderDigest`)
already exist in `diff.ts` with matching signatures. No source change
needed — but confirm at port time that the argument order matches what
the `.mjs` tests pass (they do, per the audit).

### 4. pi-advisor `tsconfig.json` (new file)

Today pi-advisor relies on the root `tsconfig.json`. With the root
`tsconfig.test.json` gone, give the package its own:

```jsonc
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "types": ["@earendil-works/pi-coding-agent", "node", "bun"]
  },
  "include": ["advisor.ts", "src/**/*.ts"],
  "exclude": ["node_modules", "tests"]
}
```

Why `bun` in `types`: `@types/bun` is a root `devDependency`; listing it
here makes `Bun.*` ambient types resolvable for any source file that
references them. Tests are excluded from tsc (`bun test` validates them,
matching the pattern already used in `pi-llama-stats/tsconfig.json`).

### 5. pi-llama + pi-llama-stats: no test-side changes

`pi-llama/tsconfig.json` currently includes `tests/**/*.ts`. Drop that to
match `pi-llama-stats`:

```jsonc
{
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

`pi-llama-stats/tsconfig.json` already excludes tests — leave it.

### 6. pi-advisor tests: rewrite `node:test` → `bun:test`

The five files are:

- `tests/config.test.mjs` → `tests/config.test.ts`
- `tests/diff.test.mjs` → `tests/diff.test.ts`
- `tests/context-policy.test.mjs` → `tests/context-policy.test.ts`
- `tests/policy-subcommands.test.mjs` → `tests/policy-subcommands.test.ts`
- `tests/todo-trigger.test.mjs` → `tests/todo-trigger.test.ts`

**Preconditions:** steps 3a–3c must be done first (the `.ts` sources must
export everything the tests import).

Mechanical port (after preconditions):

| `node:test` | `bun:test` |
|---|---|
| `import { describe, it } from "node:test"` | `import { describe, it } from "bun:test"` |
| `import { strict as assert } from "node:assert"` | `import { expect } from "bun:test"` (or keep `node:assert` — Bun ships it natively) |
| `assert.equal(a, b)` | `expect(a).toBe(b)` (prefer; matches the style pi-llama uses) |
| `assert.deepEqual(a, b)` | `expect(a).toEqual(b)` |
| `assert.ok(a)` | `expect(a).toBeTruthy()` or `expect(a).toBe(true)` |
| `import("../src/config.mjs")` | `import("../src/config")` (drop `.mjs`; Bun resolves `.ts`) |

**Port order (do not delete .mjs until the .ts passes):**
1. Write the new `*.test.ts` file.
2. Run `bun test packages/pi-advisor/tests/<file>.test.ts` — confirm green.
3. Only then delete the matching `*.test.mjs`.

This keeps the `.mjs` baseline as a fallback until each `.ts` test is
verified green.

**Hermeticity reminder** (already enforced per
`packages/pi-advisor/AGENTS.md`): tests must not read/write real user
files. The port does not change that — keep the temp-dir pattern that
already exists.

**Special case — `todo-trigger.test.ts`:** this test does not import from
any source module; it defines an inline `isTodoCompletion` function (a
copy of the one in `advisor.ts`). The port is purely a `node:test` →
`bun:test` import swap. Keep the inline copy and its "must stay in sync"
comment.

### 7. `.mjs` shadow files in pi-advisor

After all five `.test.ts` files are green and the `.test.mjs` files are
deleted, delete the four source shadows:

`packages/pi-advisor/src/{config,diff,context-policy,summarizer}.mjs`

Verify nothing else in the repo imports these `.mjs` files:

```sh
grep -r 'src/config.mjs\|src/diff.mjs\|src/context-policy.mjs\|src/summarizer.mjs' packages/
```

`advisor.ts` imports the `.ts` sources (confirmed lines 104–110), so
nothing runtime should reach into the `.mjs` shadows. Only the (now-deleted)
`.test.mjs` files imported them.

### 8. Lockfile

- `git rm package-lock.json`.
- `bun install` writes `bun.lock` (Bun ≥ 1.2) or `bun.lockb` (Bun 1.1.x).
  Commit whichever it produces.
- Add `package-lock.json` to `.gitignore` so future accidental npm runs
  don't reintroduce it.
- Update `.gitignore` already excludes `node_modules/`, `.tmp-*/` —
  no change needed there.

### 9. Root `AGENTS.md` (new file — does not exist today)

Create `AGENTS.md` at repo root with workflow rules for the post-migration
state. See **"AGENTS.md content"** section below for the full intended
file.

### 10. Root `README.md` updates

Two surgical edits — see **"README.md edits"** section below for the
exact before/after diffs.

## AGENTS.md content (deliverable of step 9)

Drop this at `AGENTS.md` (repo root). Mirrors the global conventions in
`~/.pi/agent/AGENTS.md` but adds the post-migration specifics:

```markdown
# AGENTS.md — `pi-extensions` monorepo

## Stack

- **Runtime / package manager / test runner: Bun.** All `*.test.ts` under
  any `packages/*/tests/` are run by `bun test`. No tsc compile step in
  the test pipeline.
- **Type checking: `tsc --noEmit`** per package, composed by
  `bun run typecheck` at the root.
- **Lint/format in CI: `oxfmt` + `oxlint`** via `npx` (unchanged).

## Workflow

- Use `todo` for multi-step work. Mark in_progress before starting,
  completed immediately when done.
- BoringOps: prefer simple, predictable operations over clever or fragile
  ones. Run `bun test` and `bun run typecheck` before committing.
- Consult the advisor before substantive work and when stuck. Push back
  on its claims if evidence contradicts them.

## Testing

- **Hermetic.** Tests must never read, write, modify, or delete real
  user files. Use `tmpdir()` (`os.tmpdir()`) or Bun's `tempDir` helper.
  pi-advisor already enforces this; the rule extends to every package.
- **Test format: `bun:test`.** `import { describe, it, expect } from
  "bun:test"`. Match the style of `packages/pi-llama/tests/*.test.ts`.
- **One test per behaviour.** No trivia tests. Cover the happy path, the
  failure path, and the boundary.
- **Run a single file:** `bun test packages/<pkg>/tests/<file>.test.ts`.

## Type checking

- Per-package `tsconfig.json` is the source of truth.
- Tests are excluded from per-package tsconfigs (Bun validates them).
- `bun run typecheck` runs every package's `tsc --noEmit` sequentially.
- When adding a new package, add its `typecheck:<name>` script to the
  root `package.json` and append it to the `typecheck` composite script.

## Adding a new package

1. Create `packages/<name>/` with its own `package.json` and
   `tsconfig.json` (extend the root, set `noEmit: true`, list
   `tests` in `exclude`).
2. Add `*.test.ts` files under `packages/<name>/tests/` using `bun:test`.
3. `bun test` picks them up automatically — no root config changes.
4. Add a `typecheck:<name>` script to root `package.json` and append it
   to the `typecheck` composite script.

## Commit conventions

- Conventional Commits. `feat`, `fix`, `chore`, `docs`, `refactor`,
  `perf`, `test`, `ci`, `build`, `style`.
- Keep descriptions imperative and brief.
- License new packages MIT unless there's a reason otherwise.
```

## README.md edits (deliverable of step 10)

Two changes, both in the `## Developing` section at the bottom. Before:

```
## Developing

1. Edit the `.ts`/`.mjs` source in `packages/pi-advisor/`.
2. Run `npm test` and `npm run typecheck`.
3. Re-deploy with `pi install /path/to/pi-advisor-ext` (or copy manually and run `/reload`).
```

After:

```
## Developing

Prerequisite: [Bun](https://bun.sh) ≥ 1.1.

1. Edit the `.ts` source in any `packages/*/src/` (or
   `packages/pi-advisor/advisor.ts`).
2. Run `bun test` to execute every package's test suite and
   `bun run typecheck` to typecheck the workspace.
3. Re-deploy with `pi install /path/to/pi-advisor-ext` (or copy manually
   and run `/reload`).

### Tests

- `bun test` runs all `*.test.ts` under `packages/*/tests/`.
- `bun test packages/<pkg>` scopes to one package.
- Tests must be hermetic — no reads/writes outside temp directories.
```

Also update the title blurb and attribution only if you want to reflect
that the repo now hosts `pi-llama` and `pi-llama-stats` as well as
`pi-advisor`. The current README's title (`pi-advisor-ext`) and lede
only describe `pi-advisor`. Optional follow-up — flag as a separate
doc change in the PR.

## Execution order (recommended)

The steps above are not strictly independent. Recommended order:

1. **Step 1** — root `package.json` scripts + `@types/bun`.
2. **Step 2** — delete `tsconfig.test.json`.
3. **Step 4** — create `packages/pi-advisor/tsconfig.json`.
4. **Step 5** — update `packages/pi-llama/tsconfig.json` to exclude tests.
5. **Step 3** — reconcile source gaps (3a: port `normalizeDiffMode`;
   3b: export `renderEntry` + `truncate`; 3c: verify `diff.ts`).
6. **Step 6** — port each test file `.mjs` → `.ts`, running `bun test`
   per file before deleting the `.mjs`.
7. **Step 7** — delete the four `.mjs` source shadows.
8. **Step 8** — lockfile migration (`bun install`, `git rm
   package-lock.json`, update `.gitignore`).
9. **Step 9** — create root `AGENTS.md`.
10. **Step 10** — update root `README.md`.
11. **Verification** — run the full checklist below.

## Verification

- [ ] `rm -rf node_modules bun.lock bun.lockb package-lock.json .tmp-test`
- [ ] `bun install` — produces `bun.lock` (or `bun.lockb` on 1.1.x),
      no `package-lock.json`.
- [ ] `bun test` — green across all three test packages
      (pi-advisor, pi-llama, pi-llama-stats). Expect ≥ 181 pass / 0 fail.
- [ ] `bun run typecheck` — green (or documents deliberate `any`/`as`
      relaxations where source code requires it).
- [ ] `grep -r '"node:test"' packages/` — no matches.
- [ ] `grep -r '\.test\.mjs' packages/` — no matches.
- [ ] `grep -r 'src/.*\.mjs' packages/pi-advisor/src/` — no matches
      (the shadow `.mjs` files are gone).
- [ ] `grep -r 'normalizeDiffMode' packages/pi-advisor/src/config.ts` —
      the function is now exported.
- [ ] `grep -r 'export function renderEntry' packages/pi-advisor/src/context-policy.ts` —
      the function is now exported.
- [ ] `git status` shows `package-lock.json` deleted and the new lockfile
      added; `.gitignore` covers future re-introductions.
- [ ] `bun test` is reproducible — delete `node_modules`, re-run
      `bun install && bun test`, still green.

## Out of scope (deliberately)

- Migrating pi-llama and pi-omlx CI workflows from `npx` to `bunx`.
  Current `npx oxfmt` + `npx oxlint` steps keep working under Bun-installed
  `node_modules`. PR-worthy later if/when we want to drop npm entirely.
- Rewriting the README's title/lede to mention pi-llama and pi-llama-stats.
  Separate doc-only PR.
- Porting `node:test`-specific assertions to `bun:test` style (e.g.
  `assert.rejects`) on a case-by-case basis — the mechanical port above
  is the floor; clean up styles opportunistically.
- Reconciling the `.mjs`-only helpers (`readConfig`, `DEFAULT_TIMEOUT_MS`,
  `renderStatDigest`, `renderSnippetsDigest`, `collectChangesFromGit`,
  `SummarySource`) into the `.ts` sources. No test imports them; they are
  deleted with the shadows. If a future feature needs them, port from git
  history at that point.
