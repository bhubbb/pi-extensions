import type { GoalStatus, TaskStatus } from "../tool/types.js";

/**
 * Allowed forward transitions per source status.
 * `completed` is one-way to `deleted`; `deleted` is terminal.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

/**
 * Goal status transitions. `completed` and `abandoned` are terminal in v1.
 */
export const VALID_GOAL_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  active: new Set(["completed", "abandoned"]),
  completed: new Set(),
  abandoned: new Set(),
};

export function isGoalTransitionValid(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return VALID_GOAL_TRANSITIONS[from].has(to);
}