/**
 * todo tool + /todos command — thin registration shell.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getState, replaceState } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
  COMMAND_NAME,
  ERR_REQUIRES_INTERACTIVE,
  MSG_NO_TODOS,
  type Action,
  type TaskMutationParams,
  TodoParamsSchema,
} from "./tool/types.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTasks } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Goal, Task, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

/** Backward-compat replay shim. */
export function reconstructTodoState(ctx: Parameters<typeof replayFromBranch>[0]): void {
  replaceState(replayFromBranch(ctx));
}

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'writing tests') when marking in_progress.",
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
  "Tasks belong to goals (goalId required on create). Use goal actions (add_goal, list_goal, complete_goal, abandon_goal, delete_goal) to manage grouping.",
];

export function registerTodoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a task list to track multi-step progress. Tasks belong to goals for grouping. Actions: create (new task, requires goalId), update (change status/fields/dependencies), list (all tasks, optionally filtered), get (single task), delete (tombstone), clear (reset all). Goal actions: add_goal, list_goal, get_goal, complete_goal (cascades done to all tasks), abandon_goal, delete_goal (removes goal + tasks), clear_goal. Status: pending → in_progress → completed, plus deleted. Goal status: active → completed | abandoned. Soft caps: 50 tasks, 20 goals.",
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = applyTaskMutation(getState(), params.action as any, params as TaskMutationParams);
      commitState(result.state);
      return buildToolResult(params.action as Action, params as TaskMutationParams, result.state, result.op);
    },

    renderCall(args, theme, _context) {
      return renderTodoCall(args as never, theme, getState());
    },

    renderResult(result, _opts, theme, _context) {
      return renderTodoResult(result, theme);
    },
  });
}

// English fallbacks for localized /todos section headers.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

export function registerTodosCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show all todos on the current branch, grouped by goal and status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
        return;
      }
      const state = getState();
      const visible = selectVisibleTasks(state);
      if (visible.length === 0) {
        ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
        return;
      }
      const groups = selectTasksByStatus(state);
      const counts = selectTodoCounts(state);

      const header: string[] = [];
      if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
      if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
      if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

      const lines: string[] = [header.join(" · ")];

      // Group tasks by goal
      const tasksByGoal = new Map<number, (typeof visible)[number][]>();
      for (const task of visible) {
        const arr = tasksByGoal.get(task.goalId) ?? [];
        arr.push(task);
        tasksByGoal.set(task.goalId, arr);
      }

      for (const [goalId, goalTasks] of tasksByGoal) {
        const goal = state.goals.find((g) => g.id === goalId);
        if (goal) {
          lines.push(`  Goal #${goal.id}: ${goal.title} [${goal.status}]`);
        }
        if (goalTasks.filter((t) => t.status === "pending").length > 0) {
          lines.push(t("command.section.pending", SECTION_PENDING));
          for (const task of goalTasks.filter((t) => t.status === "pending")) {
            lines.push(formatCommandTaskLine(task, "○", goal?.title));
          }
        }
        if (goalTasks.filter((t) => t.status === "in_progress").length > 0) {
          lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
          for (const task of goalTasks.filter((t) => t.status === "in_progress")) {
            lines.push(formatCommandTaskLine(task, "◐", goal?.title));
          }
        }
        if (goalTasks.filter((t) => t.status === "completed").length > 0) {
          lines.push(t("command.section.completed", SECTION_COMPLETED));
          for (const task of goalTasks.filter((t) => t.status === "completed")) {
            lines.push(formatCommandTaskLine(task, "✓", goal?.title));
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}