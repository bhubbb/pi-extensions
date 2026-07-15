import type { Goal, Task } from "../tool/types.js";

/**
 * Canonical state for the todo+goal tool. Single source of truth.
 */
export interface TaskState {
  goals: Goal[];
  tasks: Task[];
  nextGoalId: number;
  nextId: number;
}

export const EMPTY_STATE: TaskState = {
  goals: [],
  tasks: [],
  nextGoalId: 1,
  nextId: 1,
};