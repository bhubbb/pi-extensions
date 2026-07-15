# AGENTS.md — `pi-extensions` monorepo

## Stack

- **Runtime / package manager / test runner: Bun.** All `*.test.ts` under `packages/*/tests/` are run by `bun test`. No `tsc` compile step in the test pipeline. **Everything in this monorepo uses Bun — no npm, no yarn, no pnpm.**
- **Type checking: `tsc --noEmit`** per package, composed by `bun run typecheck` at the root.
- **Lint/format in CI: `oxfmt` + `oxlint`** via `npx` (unchanged).
- **Test framework: `bun:test` only.** No vitest, jest, or other test runners. Port any external packages to `bun:test`.

## Workflow

- Use `todo` for multi-step work. Mark `in_progress` before starting, `completed` immediately when done.
- BoringOps: prefer simple, predictable operations over clever or fragile ones. Run `bun test` and `bun run typecheck` before committing.
- Consult the advisor before substantive work and when stuck. Push back on its claims if evidence contradicts them.

## Testing

- **Hermetic.** Tests must never read, write, modify, or delete real user files. Use `tmpdir()` (`os.tmpdir()`) or Bun's `tempDir` helper. `pi-advisor` already enforces this; the rule extends to every package.
- **Test format: `bun:test`.** `import { describe, it, expect } from "bun:test"`. Match the style of `packages/pi-llama/tests/*.test.ts`.
- **One test per behaviour.** No trivia tests. Cover the happy path, the failure path, and the boundary.
- **Run a single file:** `bun test packages/<pkg>/tests/<file>.test.ts`.

## Type checking

- Per-package `tsconfig.json` is the source of truth.
- Tests are excluded from per-package tsconfigs (Bun validates them).
- `bun run typecheck` runs every package's `tsc --noEmit` sequentially.
- When adding a new package, add its `typecheck:<name>` script to root `package.json` and append it to the `typecheck` composite script.

## Adding a new package

1. Create `packages/<name>/` with its own `package.json` and `tsconfig.json` (extend the root, set `noEmit: true`, list `tests` in `exclude`).
2. Add `*.test.ts` files under `packages/<name>/tests/` using `bun:test`.
3. `bun test` picks them up automatically — no root config changes.
4. Add a `typecheck:<name>` script to root `package.json` and append it to the `typecheck` composite script.

## Commit conventions

- Conventional Commits. `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`, `build`, `style`.
- Keep descriptions imperative and brief.
- License new packages MIT unless there's a reason otherwise.

## Hermeticity (critical)

- Never touch `~/.pi/`, `~/.config/`, `~/.local/share/`, or any user-specific path in tests.
- All config writes in tests must use a temp directory.
- If `process.env.HOME` is overridden, it must be restored in a `finally` block before cleanup.
- `os.homedir()` is called by `config.ts` at runtime; override it only within the test's try/finally block.