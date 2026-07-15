import { formatGoalStatusLabel } from "../state/i18n-bridge.js";
import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import type { Goal, Task, TaskDetails, TaskMutationParams } from "./types.js";
import type { Action } from "./types.js";

/**
 * Format a single task as a list line.
 */
function formatListLine(t: Task, goalTitle: string | undefined): string {
  const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  const goalTag = goalTitle ? ` [${goalTitle}]` : "";
  return `[${t.status}] #${t.id} ${t.subject}${goalTag}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action.
 */
function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const goal = state.goals.find((g) => g.id === task.goalId);
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (goal) lines.push(`  goal: #${goal.id} ${goal.title}`);
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) {
    lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (blocks.length) {
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  }
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines.join("\n");
}

/**
 * Format a single goal as a list line.
 */
function formatGoalListLine(g: Goal): string {
  const fileTag = g.file ? ` (file: ${g.file})` : "";
  const completedTag = g.completedAt ? ` (done ${new Date(g.completedAt).toISOString().slice(11, 19)})` : "";
  return `  [${g.status}] #${g.id}: ${g.title}${fileTag}${completedTag}`;
}

/**
 * Multi-line presentation for the `get_goal` action.
 */
function formatGoalGetLines(goal: Goal, state: TaskState): string {
  const tasks = state.tasks.filter((t) => t.goalId === goal.id && t.status !== "deleted");
  const lines = [`#${goal.id} [${goal.status}] ${goal.title}`];
  if (goal.description) lines.push(`  description: ${goal.description}`);
  if (goal.file) lines.push(`  file: ${goal.file}`);
  if (goal.completedAt) lines.push(`  completed at: ${new Date(goal.completedAt).toISOString().slice(11, 19)}`);
  lines.push(`  tasks: ${tasks.length} (${tasks.filter((t) => t.status === "completed").length} done)`);
  return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`.
 */
export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      const goal = state.goals.find((g) => g.id === op.goalId);
      const goalTag = goal ? ` in goal #${goal.id} [${goal.title}]` : "";
      if (!t) return `Created #${op.taskId}`;
      return `Created #${t.id}: ${t.subject} (pending)${goalTag}`;
    }
    case "update": {
      const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
      return `Updated #${op.id}${transition}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${op.subject}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
      if (view.length === 0) return "No tasks";
      return view.map((t) => formatListLine(t, state.goals.find((g) => g.id === t.goalId)?.title)).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "create_goal": {
      const g = state.goals.find((x) => x.id === op.goalId);
      if (!g) return `Created goal #${op.goalId}`;
      return `Created goal #${g.id}: ${g.title} (active)`;
    }
    case "list_goal": {
      if (state.goals.length === 0) return "No goals";
      return state.goals.map(formatGoalListLine).join("\n");
    }
    case "get_goal":
      return formatGoalGetLines(op.goal, state);
    case "update_goal": {
      const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
      return `Updated goal #${op.goalId}${transition}`;
    }
    case "complete_goal":
      return `Completed goal #${op.goalId} (all tasks marked done)`;
    case "abandon_goal":
      return `Abandoned goal #${op.goalId}`;
    case "delete_goal":
      return `Deleted goal #${op.goalId}: ${op.title} and all tasks`;
    case "clear_goal":
      return `Cleared ${op.count} goals and all tasks`;
    case "error":
      return `Error: ${op.message}`;
  }
}

/**
 * Build the LLM-facing tool envelope.
 */
export function buildToolResult(
  action: Action,
  params: TaskMutationParams,
  state: TaskState,
  op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
  const text = formatContent(op, state);

  // Hot/cold split: active goals + their tasks are "hot", archived are "cold"
  const activeGoalIds = new Set(state.goals.filter((g) => g.status === "active").map((g) => g.id));
  const hotTasks = state.tasks.filter((t) => activeGoalIds.has(t.goalId));
  const archivedGoals = state.goals.filter((g) => g.status !== "active");
  const archivedTasks = state.tasks.filter((t) => !activeGoalIds.has(t.goalId));

  const details: TaskDetails = {
    action,
    params: params as Record<string, unknown>,
    goals: state.goals,
    tasks: state.tasks,
    nextGoalId: state.nextGoalId,
    nextId: state.nextId,
    archivedGoals: archivedGoals.length > 0 ? archivedGoals : undefined,
    archivedTasks: archivedTasks.length > 0 ? archivedTasks : undefined,
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return { content: [{ type: "text", text }], details };
}