/**
 * i18n bridge for pi-todo. English-only fallback (no external i18n SDK).
 */

import type { GoalStatus, TaskStatus } from "../tool/types.js";

export const I18N_NAMESPACE = "pi-todo";

/** Simple identity passthrough — returns the English fallback. */
export function t(_key: string, fallback: string): string {
  return fallback;
}

export function formatStatusLabel(status: TaskStatus): string {
  const LABELS: Record<TaskStatus, string> = {
    pending: "pending",
    in_progress: "in progress",
    completed: "completed",
    deleted: "deleted",
  };
  return LABELS[status];
}

export function formatGoalStatusLabel(status: GoalStatus): string {
  const LABELS: Record<GoalStatus, string> = {
    active: "active",
    completed: "completed",
    abandoned: "abandoned",
  };
  return LABELS[status];
}