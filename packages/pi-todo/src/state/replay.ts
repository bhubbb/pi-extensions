import type { TaskDetails } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails` shape.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
  let result: TaskState = {
    goals: [...EMPTY_STATE.goals],
    tasks: [...EMPTY_STATE.tasks],
    nextGoalId: EMPTY_STATE.nextGoalId,
    nextId: EMPTY_STATE.nextId,
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
    if (e.type !== "message") continue;
    const msg = e.message;
    if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
    if (!isTaskDetails(msg.details)) continue;
    result = {
      goals: msg.details.goals ? msg.details.goals.map((g) => ({ ...g })) : [],
      tasks: msg.details.tasks.map((t) => ({ ...t })),
      nextGoalId: msg.details.nextGoalId ?? 1,
      nextId: msg.details.nextId,
    };
  }
  return result;
}