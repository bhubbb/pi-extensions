import type { Action, Goal, GoalStatus, Task, TaskMutationParams, TaskStatus } from "../tool/types.js";
import { MAX_GOALS, MAX_TODOS } from "../tool/types.js";
import { isGoalTransitionValid, isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome — closed tagged union.
 */
export type Op =
  | { kind: "create"; taskId: number; goalId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  // Goal ops
  | { kind: "create_goal"; goalId: number }
  | { kind: "update_goal"; goalId: number; fromStatus: GoalStatus; toStatus: GoalStatus }
  | { kind: "complete_goal"; goalId: number }
  | { kind: "abandon_goal"; goalId: number }
  | { kind: "delete_goal"; goalId: number; title: string }
  | { kind: "clear_goal"; count: number }
  | { kind: "list_goal" }
  | { kind: "get_goal"; goal: Goal }
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

/**
 * Pure reducer: (state, action, params) → (state, op).
 *
 * Task actions: create, update, list, get, delete, clear
 * Goal actions: list_goal, add_goal, update_goal, get_goal, complete_goal, abandon_goal, delete_goal, clear_goal
 */
export function applyTaskMutation(state: TaskState, action: Action, params: TaskMutationParams): ApplyResult {
  // -----------------------------------------------------------------------
  // Task actions
  // -----------------------------------------------------------------------

  switch (action) {
    case "create": {
      if (!params.subject?.trim()) {
        return errorResult(state, "subject required for create");
      }
      if (!params.goalId || params.goalId < 1) {
        return errorResult(state, "goalId required for create");
      }
      // Validate goal exists
      if (!state.goals.find((g) => g.id === params.goalId)) {
        return errorResult(state, `goal #${params.goalId} not found`);
      }
      // Soft cap check
      if (state.tasks.length >= MAX_TODOS) {
        return errorResult(state, `max tasks (${MAX_TODOS}) reached — use clear or delete to free space`);
      }
      // Validate blockedBy deps
      if (params.blockedBy?.length) {
        for (const dep of params.blockedBy) {
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
          if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
        }
      }
      const newTask: Task = {
        id: state.nextId,
        goalId: params.goalId as number,
        subject: params.subject,
        status: "pending",
      };
      if (params.description) newTask.description = params.description;
      if (params.activeForm) newTask.activeForm = params.activeForm;
      if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
      if (params.owner) newTask.owner = params.owner;
      if (params.metadata) newTask.metadata = { ...params.metadata };

      return {
        state: { ...state, tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
        op: { kind: "create", taskId: newTask.id, goalId: newTask.goalId },
      };
    }

    case "update": {
      if (params.id === undefined) return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        params.owner !== undefined ||
        params.metadata !== undefined ||
        (params.addBlockedBy && params.addBlockedBy.length > 0) ||
        (params.removeBlockedBy && params.removeBlockedBy.length > 0);
      if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

      let newStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
        }
        newStatus = params.status;
      }

      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const toRemove = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
          if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
          if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy)) {
          return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
        }
      }

      let newMetadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
        for (const [k, v] of Object.entries(params.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        newMetadata = Object.keys(merged).length ? merged : undefined;
      }

      const updated: Task = { ...current, status: newStatus };
      if (params.subject !== undefined) updated.subject = params.subject;
      if (params.description !== undefined) updated.description = params.description;
      if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;
      if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;
      if (newMetadata === undefined) delete updated.metadata;
      else updated.metadata = newMetadata;

      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { ...state, tasks: newTasks },
        op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
      };
    }

    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined ? { statusFilter: params.status } : {}),
        },
      };
    }

    case "get": {
      if (params.id === undefined) return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined) return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
      const updated: Task = { ...current, status: "deleted" };
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { ...state, tasks: newTasks },
        op: { kind: "delete", id: updated.id, subject: updated.subject },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return {
        state: { ...state, tasks: [], nextId: 1 },
        op: { kind: "clear", count },
      };
    }

    // -----------------------------------------------------------------------
    // Goal actions
    // -----------------------------------------------------------------------

    case "add_goal": {
      if (!params.title?.trim()) {
        return errorResult(state, "title required for add_goal");
      }
      // Soft cap — can reuse abandoned goals
      const inactiveGoals = state.goals.filter((g) => g.status === "abandoned");
      if (state.goals.length >= MAX_GOALS && inactiveGoals.length === 0) {
        return errorResult(state, `max goals (${MAX_GOALS}) reached — use delete_goal to free space`);
      }

      // Reuse first abandoned goal if at cap
      if (state.goals.length >= MAX_GOALS && inactiveGoals.length > 0) {
        const reused = inactiveGoals[0];
        const updated: Goal = {
          ...reused,
          title: params.title.trim(),
          description: params.description ? params.description : undefined,
          file: params.file ? params.file : undefined,
          status: "active",
          createdAt: Date.now(),
          completedAt: undefined,
        };
        const newGoals = [...state.goals];
        const idx = newGoals.findIndex((g) => g.id === reused.id);
        newGoals[idx] = updated;
        return {
          state: { ...state, goals: newGoals },
          op: { kind: "create_goal", goalId: updated.id },
        };
      }

      const newGoal: Goal = {
        id: state.nextGoalId,
        title: params.title.trim(),
        description: params.description ? params.description : undefined,
        file: params.file ? params.file : undefined,
        status: "active",
        createdAt: Date.now(),
      };
      return {
        state: { ...state, goals: [...state.goals, newGoal], nextGoalId: state.nextGoalId + 1 },
        op: { kind: "create_goal", goalId: newGoal.id },
      };
    }

    case "list_goal": {
      return { state, op: { kind: "list_goal" } };
    }

    case "get_goal": {
      if (!params.goalId || params.goalId < 1) return errorResult(state, "goalId required for get_goal");
      const goal = state.goals.find((g) => g.id === params.goalId);
      if (!goal) return errorResult(state, `goal #${params.goalId} not found`);
      return { state, op: { kind: "get_goal", goal } };
    }

    case "update_goal": {
      if (!params.goalId || params.goalId < 1) return errorResult(state, "goalId required for update_goal");
      const idx = state.goals.findIndex((g) => g.id === params.goalId);
      if (idx === -1) return errorResult(state, `goal #${params.goalId} not found`);
      const current = state.goals[idx];

      // Check status transition
      if (params.goalStatus && !isGoalTransitionValid(current.status, params.goalStatus)) {
        return errorResult(state, `illegal goal transition ${current.status} → ${params.goalStatus}`);
      }

      const updated: Goal = { ...current };
      if (params.title) updated.title = params.title;
      if (params.description !== undefined) updated.description = params.description;
      if (params.file !== undefined) updated.file = params.file;
      if (params.goalStatus) {
        updated.status = params.goalStatus;
        if (params.goalStatus === "completed") {
          updated.completedAt = Date.now();
        }
      }

      const newGoals = [...state.goals];
      newGoals[idx] = updated;
      return {
        state: { ...state, goals: newGoals },
        op: { kind: "update_goal", goalId: updated.id, fromStatus: current.status, toStatus: updated.status },
      };
    }

    case "complete_goal": {
      if (!params.goalId || params.goalId < 1) return errorResult(state, "goalId required for complete_goal");
      const idx = state.goals.findIndex((g) => g.id === params.goalId);
      if (idx === -1) return errorResult(state, `goal #${params.goalId} not found`);
      const current = state.goals[idx];
      if (current.status !== "active") return errorResult(state, `goal #${params.goalId} is not active`);

      // Cascade: mark all tasks in this goal as done
      const newTasks = state.tasks.map((t) =>
        t.goalId === params.goalId ? { ...t, status: "completed" as TaskStatus } : t,
      );

      const updated: Goal = { ...current, status: "completed", completedAt: Date.now() };
      const newGoals = [...state.goals];
      newGoals[idx] = updated;

      return {
        state: { ...state, goals: newGoals, tasks: newTasks },
        op: { kind: "complete_goal", goalId: updated.id },
      };
    }

    case "abandon_goal": {
      if (!params.goalId || params.goalId < 1) return errorResult(state, "goalId required for abandon_goal");
      const idx = state.goals.findIndex((g) => g.id === params.goalId);
      if (idx === -1) return errorResult(state, `goal #${params.goalId} not found`);
      const current = state.goals[idx];
      if (current.status !== "active") return errorResult(state, `goal #${params.goalId} is not active`);

      const updated: Goal = { ...current, status: "abandoned" };
      // Leave tasks as-is for review
      const newGoals = [...state.goals];
      newGoals[idx] = updated;

      return {
        state: { ...state, goals: newGoals },
        op: { kind: "abandon_goal", goalId: updated.id },
      };
    }

    case "delete_goal": {
      if (!params.goalId || params.goalId < 1) return errorResult(state, "goalId required for delete_goal");
      const idx = state.goals.findIndex((g) => g.id === params.goalId);
      if (idx === -1) return errorResult(state, `goal #${params.goalId} not found`);
      const goalToRemove = state.goals[idx];

      // Hard delete: remove goal AND all its tasks
      const newTasks = state.tasks.filter((t) => t.goalId !== params.goalId);
      const newGoals = [...state.goals];
      newGoals.splice(idx, 1);

      return {
        state: { ...state, goals: newGoals, tasks: newTasks },
        op: { kind: "delete_goal", goalId: goalToRemove.id, title: goalToRemove.title },
      };
    }

    case "clear_goal": {
      const count = state.goals.length;
      // Clear all goals AND all tasks
      return {
        state: { goals: [], tasks: [], nextGoalId: 1, nextId: 1 },
        op: { kind: "clear_goal", count },
      };
    }

    default:
      return errorResult(state, `unknown action: ${action}`);
  }
}