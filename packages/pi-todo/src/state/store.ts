import type { Goal, Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Module-level live state cell.
 */
let state: TaskState = {
  goals: [...EMPTY_STATE.goals],
  tasks: [...EMPTY_STATE.tasks],
  nextGoalId: EMPTY_STATE.nextGoalId,
  nextId: EMPTY_STATE.nextId,
};

/** Live goals accessor. */
export function getGoals(): readonly Goal[] {
  return state.goals;
}

/** Live tasks accessor. */
export function getTasks(): readonly Task[] {
  return state.tasks;
}

export function getNextId(): number {
  return state.nextId;
}

/** Snapshot accessor used by reducer callers. */
export function getState(): TaskState {
  return state;
}

/** Replay seam — lifecycle handlers write via this. */
export function replaceState(next: TaskState): void {
  state = next;
}

/** Post-reducer commit seam. */
export function commitState(next: TaskState): void {
  state = next;
}

/** Test-setup reset. */
export function __resetState(): void {
  state = {
    goals: [...EMPTY_STATE.goals],
    tasks: [...EMPTY_STATE.tasks],
    nextGoalId: EMPTY_STATE.nextGoalId,
    nextId: EMPTY_STATE.nextId,
  };
}