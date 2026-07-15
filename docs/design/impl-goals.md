# Implementation: pi-goals — extend the todo extension with a goal layer

## Goal

Add a `Goal` layer above the existing todo plugin so work can be grouped,
described, and tied to a file in the repo. Todos become children of goals.

## Preconditions

### Monorepo migration

The current `todo` logic lives as an example in
`@earendil-works/pi-coding-agent` (`examples/extensions/todo.ts`). This work
**cannot start** until that code is pulled into the monorepo as a first-class
package.

**Proposed package: `packages/pi-todo`**

Files to move (from `examples/extensions/todo.ts`):
- `todo.ts` → `packages/pi-todo/src/index.ts` (or `tool.ts`)
- Extract `TodoListComponent` → `packages/pi-todo/src/ui/TodoList.ts`
- Tests: `packages/pi-todo/tests/todo.test.ts`

**`package.json` shape:**
- name: `@pi-extensions/todo`
- type: `module`
- main: `./dist/index.js`
- peer dep: `@earendil-works/pi-coding-agent`
- dev deps: `typebox`, `@earendil-works/pi-tui`
- scripts: `build`, `test`, `lint`
- workspaces: add to root `package.json` `workspaces[]`

**Then, for goals:** extend the same package or create `packages/pi-goals`
sibling. Open question 1.

## Decisions made

| Question | Decision | Why |
|---|---|---|
| `goalId` on `Todo` | **required** | Clean hierarchy. "Scratchpad" tasks can live in a throwaway goal — no need for a parallel free-floating track. |
| Tool surface | **one tool** | Keep state reconstruction as one loop; one snapshot shape. |
| Action shape | **deferred — see below** | Two reasonable shapes; needs a pick before implementation. |
| Storage | **in-session snapshot (v1)** | Matches existing pattern. Limits documented; revisit if lists grow. |

## Model shape

```
Goal 1───* Todo
Goal 0..1─── File (path)
```

### `Goal`

| field | type | notes |
|---|---|---|
| `id` | number | stable within session |
| `title` | string | short label |
| `description?` | string | optional |
| `file?` | string | repo-relative path; **not validated in v1** |
| `status` | `"active" \| "completed" \| "abandoned"` | `completed` and `abandoned` are terminal in v1 |
| `createdAt` | number | epoch ms |
| `completedAt?` | number | epoch ms, set on `completed` |

### `Todo` (extended)

| field | type | notes |
|---|---|---|
| `id` | number | stable within session |
| `goalId` | number | **required**, FK to `Goal.id` |
| `text` | string | |
| `done` | boolean | |
| `createdAt` | number | epoch ms |

## Tool surface — two shape options

The action enum will grow. Two ways to keep it sane:

### Option A — flat, prefixed actions (recommended)

```
action ∈ {
  list_todo, add_todo, toggle_todo, clear_todo,
  list_goal, add_goal, complete_goal, abandon_goal, clear_goal
}
```

Pro: simple for the LLM, easy to dispatch.
Con: enum gets long.

### Option B — structured command

```
command:
  kind: "todo" | "goal"
  op:   list | add | toggle | clear | complete | abandon
```

Pro: bounded enum size.
Con: slightly more parameters for the LLM to fill; nested object.

**Need a pick before implementation.** Defaulting to A unless told otherwise.

## Persistence shape

Mirrors the existing plugin: every tool call returns the **full** snapshot in
`details`. The new snapshot:

```
{
  action: string,
  goals: Goal[],
  todos: Todo[],
  nextGoalId: number,
  nextTodoId: number,
  error?: string
}
```

Session branching works for free because reconstruction iterates the branch.

## Scaling risk (acknowledged)

The snapshot-in-details pattern **scales poorly**. Every list/toggle call
serialises the whole state into the tool response. With goals added, every
call now ships both arrays. Real symptoms:

- Token usage grows linearly with list size
- `list_todo` with 50 todos + 5 goals adds ~3-5k tokens per call to context

### v1 mitigation (concrete)

**Cap:** soft cap of **50 todos and 20 goals** per session. Above this, the
tool description tells the LLM to `clear_goal` or split sessions.

**Archive rule:** the snapshot is split into hot + cold slices:

```
details: {
  goals: Goal[],           // status === "active", always included
  todos: Todo[],           // goalId in active goals, always included
  archivedGoals: Goal[],   // status !== "active", excluded by default
  archivedTodos: Todo[],   // goalId in archived goals, excluded by default
  nextGoalId, nextTodoId,
  action, error?
}
```

Default responses omit `archivedGoals` and `archivedTodos`. A new action
`list_archived` returns the cold slices. `list_goal` with no id shows only
hot data. This keeps the hot path bounded by active-work size, not
lifetime size.

**Tool description warning:** the registered tool description explicitly
tells the LLM that snapshots are expensive and to prefer targeted actions
(`toggle_todo` over `list_todo`) when possible.

### Snapshot size, worked example

| State | Hot tokens | Total with archive |
|---|---|---|
| 1 goal, 3 todos | ~200 | ~200 |
| 5 goals, 20 todos | ~1.5k | ~1.5k |
| 20 goals, 50 todos (at cap) | ~5k | ~5k |
| 20 active + 10 archived, 50 todos | ~5k | ~8k |
| Beyond cap (LLM warned) | grows linearly | grows linearly |

The cap keeps hot-path under ~5k tokens. Archive stays cold until asked.

### Future (not v1)

If lists routinely exceed the cap, move state to an external file
(`./.pi/goals-<sessionId>.json`) and return only deltas in `details`.
Branching reconciliation then becomes real work — defer until needed.

## Referential integrity

The snapshot has no DB constraints. The tool must enforce:

- `add_todo` without a valid `goalId` → error, no mutation
- `complete_goal` / `abandon_goal` cascades todos to `done = true`
  (only for `complete_goal`; `abandon_goal` leaves todos as-is for review)
- `clear_goal` deletes the goal **and** its todos
- `list_todo` / `list_goal` against a non-existent `id` → error, no mutation

These are response-time checks, not snapshot-time.

## UI surface (sketch only)

- `/todos` — keep as-is, but now groups output under goal headings
- `/goals` — new, shows goals + completion %, click to expand todos
- Component classes mirror the existing `TodoListComponent`

## File-path validation

`Goal.file` is stored as a string, **not validated** in v1. Rationale:

- Sandboxed sessions may not have a real FS
- Path is informational ("here's the spec this goal is implementing"),
  not a live link
- v2 can add a "verify file exists" action if needed

## Out of scope (v1)

- Goal hierarchy (goals containing goals) — flat only
- Reopening a completed/abandoned goal
- Per-todo ordering / priority
- Persistence across sessions (state lives in session history only)
- External state file (see Scaling risk)
- File-path validation
- Per-goal "active" focus that auto-fills `goalId` on `add_todo`

## Open questions

1. **One package or two?** `pi-todo` + `pi-goals`, or merge into `pi-todo`?
   Lean: same package, separate files. Keeps the migration simple.
2. **Action shape** — A (flat) or B (structured command)?
3. **Soft-delete vs hard-delete on `clear_goal`** — leaning hard-delete;
   matches existing `clear` behaviour.

## Test sketch (positive / negative / boundary)

- add_goal → list_goal shows it
- add_todo without goalId → error, no mutation
- add_todo with bogus goalId → error, no mutation
- complete_goal cascades todo.done = true
- abandon_goal leaves todos untouched
- clear_goal removes goal + its todos
- session branch replay reconstructs goals and todos correctly
- snapshot size stays bounded with `clearedGoals[]` excluded
