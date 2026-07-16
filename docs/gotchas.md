# Gotchas

Lessons learned from debugging and testing sessions.

## bun -e for TUI logic verification

Use `bun -e` with direct function calls to inspect plain-text rendering
output (tree chars, icons, layout) without launching the full TUI.

```bash
bun -e "
import { renderNestedGoalsLayout } from './packages/pi-todo/src/view/format.ts';
import { TaskState } from './packages/pi-todo/src/state/state.ts';

const state: TaskState = { /* ... */ };
const layout = renderNestedGoalsLayout(state, new Set());
console.log('Heading:', layout.heading);
for (const g of layout.goalGroups) {
  console.log('Goal:', g.goalLine);
  for (const t of g.taskLines) console.log('Task:', t);
}
"
```

## Explicit vs derived state mismatch

When rendering UI elements (headings, icons), always source state from the
same selector. Mixing explicit status (`goal.status`) with derived state
(task progress) causes subtle inconsistencies — e.g. heading showed `◐`
while goal icon showed `✓` because one used `selectGoalCounts` (explicit)
and the other used `selectGoalIconState` (derived).

**Rule**: If icons are derived, headings must be derived too.

## todo tool parameter naming

- `update` uses `id`
- `complete_goal` and `delete_goal` use `goalId`
- This is inconsistent by design (task vs goal operations)