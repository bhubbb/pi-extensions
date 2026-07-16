import type { Goal, GoalStatus, Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
  return state.tasks.filter((t) => t.status !== "deleted");
}

/** Goals excluding completed/abandoned. */
export function selectActiveGoals(state: TaskState): readonly Goal[] {
  return state.goals.filter((g) => g.status === "active");
}

export interface TasksByStatus {
  pending: readonly Task[];
  inProgress: readonly Task[];
  completed: readonly Task[];
}

/** Group visible tasks by status. */
export function selectTasksByStatus(state: TaskState): TasksByStatus {
  const visible = selectVisibleTasks(state);
  return {
    pending: visible.filter((t) => t.status === "pending"),
    inProgress: visible.filter((t) => t.status === "in_progress"),
    completed: visible.filter((t) => t.status === "completed"),
  };
}

/** Group goals by status. */
export interface GoalsByStatus {
  active: readonly Goal[];
  completed: readonly Goal[];
  abandoned: readonly Goal[];
}
export function selectGoalsByStatus(state: TaskState): GoalsByStatus {
  return {
    active: state.goals.filter((g) => g.status === "active"),
    completed: state.goals.filter((g) => g.status === "completed"),
    abandoned: state.goals.filter((g) => g.status === "abandoned"),
  };
}

export interface TodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
  const groups = selectTasksByStatus(state);
  return {
    total: groups.pending.length + groups.inProgress.length + groups.completed.length,
    pending: groups.pending.length,
    inProgress: groups.inProgress.length,
    completed: groups.completed.length,
  };
}

export function selectGoalCounts(state: TaskState): { total: number; active: number; completed: number; abandoned: number } {
  const groups = selectGoalsByStatus(state);
  return {
    total: state.goals.length,
    active: groups.active.length,
    completed: groups.completed.length,
    abandoned: groups.abandoned.length,
  };
}

/** Whether any visible task carries a `blockedBy` reference. */
export function selectShowTaskIds(state: TaskState): boolean {
  return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/** Resolve a task's subject by id from the live state. */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
  return state.tasks.find((t) => t.id === id)?.subject;
}

/** Resolve a goal's title by id. */
export function selectGoalTitleById(state: TaskState, id: number): string | undefined {
  return state.goals.find((g) => g.id === id)?.title;
}

/** Get tasks for a specific goal. */
export function selectTasksByGoal(state: TaskState, goalId: number): readonly Task[] {
  return selectVisibleTasks(state).filter((t) => t.goalId === goalId);
}

/** Overlay layout decision. */
export interface OverlayLayout {
  visible: readonly Task[];
  hiddenCompleted: number;
  truncatedTail: number;
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
  const all = selectVisibleTasks(state);
  if (all.length <= budget) {
    return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const innerBudget = budget - 1;
  const nonCompleted = all.filter((t) => t.status !== "completed");
  const totalCompleted = all.length - nonCompleted.length;
  if (nonCompleted.length <= innerBudget) {
    const kept = new Set<Task>(nonCompleted);
    for (const t of all) {
      if (kept.size >= innerBudget) break;
      if (t.status === "completed") kept.add(t);
    }
    const visible = all.filter((t) => kept.has(t));
    const shownCompleted = visible.filter((t) => t.status === "completed").length;
    return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
  }
  const visible = nonCompleted.slice(0, innerBudget);
  const truncatedTail = nonCompleted.length - innerBudget;
  return { visible, hiddenCompleted: totalCompleted, truncatedTail: 0 };
}

export function selectHasActive(state: TaskState): boolean {
  return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);

/**
 * Derived icon state for a goal based on its tasks.
 * `done` — all tasks completed (or no tasks)
 * `in_progress` — any task is in_progress
 * `not_started` — otherwise
 */
export type GoalIconState = "not_started" | "in_progress" | "done";

/**
 * Derive a goal's icon state from its visible tasks.
 * This lets the overlay show ◐ / ✓ / ○ for goals the same way it does for tasks.
 */
export function selectGoalIconState(state: TaskState, goalId: number): GoalIconState {
  const tasks = selectTasksByGoal(state, goalId);
  if (tasks.length === 0) return "not_started";
  if (tasks.some((t) => t.status === "in_progress")) return "in_progress";
  if (tasks.every((t) => t.status === "completed")) return "done";
  return "not_started";
}

/** Completed / total task counts for a single goal. */
export function selectGoalTaskCounts(state: TaskState, goalId: number): { completed: number; total: number } {
  const tasks = selectTasksByGoal(state, goalId);
  const completed = tasks.filter((t) => t.status === "completed").length;
  return { completed, total: tasks.length };
}

/**
 * Derived goal counts based on task progress (not explicit goal status).
 * Used for the heading glyph/ratio to stay consistent with goal icons.
 * - completed: goals where all tasks are completed
 * - inProgress: goals where any task is in_progress
 * - notStarted: all other active goals
 */
export function selectDerivedGoalCounts(state: TaskState): { total: number; completed: number; inProgress: number; notStarted: number } {
  const active = selectActiveGoals(state);
  let completed = 0;
  let inProgress = 0;
  let notStarted = 0;
  for (const goal of active) {
    const iconState = selectGoalIconState(state, goal.id);
    if (iconState === "done") completed++;
    else if (iconState === "in_progress") inProgress++;
    else notStarted++;
  }
  return { total: active.length, completed, inProgress, notStarted };
}