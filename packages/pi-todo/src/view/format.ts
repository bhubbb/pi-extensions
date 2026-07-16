import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatGoalStatusLabel, formatStatusLabel } from "../state/i18n-bridge.js";
import { selectGoalIconState, selectGoalTaskCounts, selectGoalTitleById, selectTaskSubjectById, selectActiveGoals, selectDerivedGoalCounts, selectTasksByGoal, type GoalIconState } from "../state/selectors.js";
import type { TaskState } from "../state/state.js";
import type { Action, Goal, GoalStatus, Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types.js";

// ---------------------------------------------------------------------------
// Nested overlay layout
// ---------------------------------------------------------------------------

/**
 * Render the nested goals section as plain-text lines (no theme coloring).
 * Used for unit-testing the tree layout; the overlay calls this and applies theme.
 *
 * Returns the goal lines and task lines with correct tree connectors:
 *
 *   ○ Goals (0/2)
 *   ├─ ○ Goal title (1/3)
 *   │  ├─ ✓ Task 1
 *   │  ├─ ◐ Task 2
 *   │  └─ ○ Task 3
 *   └─ ✓ Done goal (2/2)
 *      ├─ ✓ Task A
 *      └─ ✓ Task B
 */
export function renderNestedGoalsLayout(
  state: TaskState,
  hiddenTaskIds: ReadonlySet<number>,
): { heading: string; goalGroups: { goalLine: string; taskLines: string[] }[] } {
  const activeGoals = selectActiveGoals(state);
  // Use derived counts (based on task progress) to stay consistent with goal icons
  const derivedCounts = selectDerivedGoalCounts(state);
  const goalRatio = derivedCounts.total > 0 ? `${derivedCounts.completed}/${derivedCounts.total}` : "0";

  // Derive heading glyph from goal aggregate (same logic as goal icons)
  const headingGlyph = derivedCounts.inProgress > 0 ? "◐" : derivedCounts.completed > 0 ? "✓" : "○";
  const heading = `${headingGlyph} Goals (${goalRatio})`;

  const goalGroups: { goalLine: string; taskLines: string[] }[] = [];

  for (let gi = 0; gi < activeGoals.length; gi++) {
    const goal = activeGoals[gi];
    const isLastGoal = gi === activeGoals.length - 1;
    const goalConnector = isLastGoal ? "└─" : "├─";

    // Goal icon derived from task statuses
    const iconState = selectGoalIconState(state, goal.id);
    const counts = selectGoalTaskCounts(state, goal.id);
    const goalGlyph = GOAL_ICON_GLYPH[iconState].glyph;
    const goalLine = `${goalConnector} ${goalGlyph} ${goal.title} (${counts.completed}/${counts.total})`;

    // Visible tasks for this goal (not deleted, not hidden)
    const goalTasks = selectTasksByGoal(state, goal.id).filter((t) => !hiddenTaskIds.has(t.id));
    const taskLines: string[] = [];
    for (let ti = 0; ti < goalTasks.length; ti++) {
      const task = goalTasks[ti];
      const isLastTask = ti === goalTasks.length - 1;
      const prefix = isLastGoal ? "   " : "│  ";
      const taskConnector = isLastTask ? "└─" : "├─";
      const taskGlyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○";
      let taskLine = `${prefix}${taskConnector} ${taskGlyph} #${task.id} ${task.subject}`;
      if (task.status === "in_progress" && task.activeForm) {
        taskLine += ` (${task.activeForm})`;
      }
      taskLines.push(taskLine);
    }

    goalGroups.push({ goalLine, taskLines });
  }

  return { heading, goalGroups };
}

// ---------------------------------------------------------------------------
// Status presentation tables
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  deleted: "⊘",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
  pending: "dim",
  in_progress: "warning",
  completed: "success",
  deleted: "muted",
};

/** Per-action prefix glyph for renderCall. */
export const ACTION_GLYPH: Record<TaskAction | GoalAction, string> = {
  create: "+",
  update: "→",
  delete: "×",
  get: "›",
  list: "☰",
  clear: "∅",
  add_goal: "+G",
  update_goal: "→G",
  delete_goal: "×G",
  get_goal: "›G",
  list_goal: "☰G",
  clear_goal: "∅G",
  complete_goal: "✓G",
  abandon_goal: "✗G",
} as const;

type GoalAction = "list_goal" | "add_goal" | "update_goal" | "get_goal" | "complete_goal" | "abandon_goal" | "delete_goal" | "clear_goal";

/** Glyph for the persistent overlay's per-task row. */
export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "in_progress":
      return theme.fg("warning", "◐");
    case "completed":
      return theme.fg("success", "✓");
    case "deleted":
      return theme.fg("error", "✗");
  }
}

/**
 * Format a single task for the overlay (with goal tag).
 */
export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean, goalTitle?: string): string {
  const glyph = overlayStatusGlyph(t.status, theme);
  const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
  let subject = theme.fg(subjectColor, t.subject);
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  let line = `${glyph}`;
  if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
  line += ` ${subject}`;
  if (goalTitle) line += ` ${theme.fg("borderMuted", `[${goalTitle}]`)}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  return line;
}

/** Glyph + color for a goal icon state (same three states as tasks). */
export const GOAL_ICON_GLYPH: Record<GoalIconState, { glyph: string; color: "dim" | "warning" | "success" }> = {
  not_started: { glyph: "○", color: "dim" },
  in_progress: { glyph: "◐", color: "warning" },
  done: { glyph: "✓", color: "success" },
};

/** Maximum lines the widget can render before truncation. */
export const MAX_WIDGET_LINES = 12;

/**
 * Format a single goal for the overlay (flat listing — kept for /todos command compat).
 */
export function formatOverlayGoalLine(g: Goal, theme: Theme): string {
  const icon = g.status === "active"
    ? theme.fg("accent", "◆")
    : g.status === "completed"
      ? theme.fg("success", "✓")
      : theme.fg("dim", "◇");
  const titleColor = g.status === "active" ? "text" : "dim";
  const fileTag = g.file ? ` ${theme.fg("borderMuted", `(file: ${g.file})`)}` : "";
  return `${icon} ${theme.fg("accent", `G#${g.id}`)} ${theme.fg(titleColor, g.title)}${fileTag}`;
}

/**
 * Format a goal header line for the nested overlay view.
 * Shows icon derived from task progress, title, and (completed/total) count.
 */
export function formatNestedGoalLine(g: Goal, state: TaskState, theme: Theme): string {
  const iconState = selectGoalIconState(state, g.id);
  const iconDef = GOAL_ICON_GLYPH[iconState];
  const counts = selectGoalTaskCounts(state, g.id);
  const icon = theme.fg(iconDef.color, iconDef.glyph);
  const titleColor = g.status === "active" ? "text" : "dim";
  const count = theme.fg("muted", `(${counts.completed}/${counts.total})`);
  return `${icon} ${theme.fg(titleColor, g.title)} ${count}`;
}

/**
 * Format a single task line for the `/todos` slash command.
 */
export function formatCommandTaskLine(t: Task, glyph: string, goalTitle?: string): string {
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const goalTag = goalTitle ? ` [${goalTitle}]` : "";
  return `  ${glyph} #${t.id} ${t.subject}${goalTag}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks
// ---------------------------------------------------------------------------

/**
 * `renderCall` body.
 */
export function renderTodoCall(
  args: TaskMutationParams & { action: Action },
  theme: Theme,
  state: TaskState,
): Text {
  const glyph = ACTION_GLYPH[args.action as TaskAction | GoalAction] ?? args.action;
  let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

  if (args.action === "create" && args.subject) {
    text += ` ${theme.fg("dim", args.subject)}`;
    if (args.goalId) text += ` ${theme.fg("accent", `goal: #${args.goalId}`)}`;
  } else if (args.action === "add_goal" && args.title) {
    text += ` ${theme.fg("dim", args.title)}`;
  } else if (
    (args.action === "update" || args.action === "get" || args.action === "delete") &&
    args.id !== undefined
  ) {
    const subject = selectTaskSubjectById(state, args.id);
    text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
  } else if (
    (args.action === "get_goal" || args.action === "complete_goal" || args.action === "abandon_goal" || args.action === "delete_goal") &&
    args.goalId !== undefined
  ) {
    const title = selectGoalTitleById(state, args.goalId as number);
    text += ` ${theme.fg("accent", title ?? `G#${args.goalId}`)}`;
  } else if (args.action === "list" && args.status) {
    text += ` ${theme.fg("muted", formatStatusLabel(args.status as TaskStatus))}`;
  }
  return new Text(text, 0, 0);
}

/**
 * `renderResult` body.
 */
export function renderTodoResult(result: { details?: unknown }, theme: Theme): Text {
  const details = result.details as TaskDetails | undefined;
  let status: TaskStatus | GoalStatus | undefined;
  if (details) {
    const params = details.params as TaskMutationParams;
    switch (details.action) {
      case "create":
        status = details.tasks[details.tasks.length - 1]?.status;
        break;
      case "update":
        status = params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
        break;
      case "delete":
        status = details.tasks.find((t) => t.id === params.id)?.status;
        break;
      case "add_goal":
      case "complete_goal":
        status = "completed";
        break;
      case "abandon_goal":
        status = "abandoned";
        break;
      case "delete_goal":
        status = "deleted";
        break;
      case "list":
      case "get":
      case "clear":
      case "list_goal":
      case "get_goal":
      case "clear_goal":
      case "update_goal":
        break;
    }
  }
  if (status) {
    // Check if it's a task or goal status
    if (["pending", "in_progress", "completed", "deleted"].includes(status)) {
      const ts = status as TaskStatus;
      return new Text(theme.fg(STATUS_COLOR[ts], `${STATUS_GLYPH[ts]} ${formatStatusLabel(ts)}`), 0, 0);
    } else {
      return new Text(theme.fg("success", `✓ ${formatGoalStatusLabel(status as GoalStatus)}`), 0, 0);
    }
  }
  return new Text(theme.fg("success", "✓"), 0, 0);
}