import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type GoalStatus = "active" | "completed" | "abandoned";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export type GoalAction =
  | "list_goal"
  | "add_goal"
  | "update_goal"
  | "get_goal"
  | "complete_goal"
  | "abandon_goal"
  | "delete_goal"
  | "clear_goal";

export type Action = TaskAction | GoalAction;

export interface Goal {
  id: number;
  title: string;
  description?: string;
  file?: string; // repo-relative path (not validated in v1)
  status: GoalStatus;
  createdAt: number; // epoch ms
  completedAt?: number; // epoch ms, set on completed
}

export interface Task {
  id: number;
  goalId: number; // FK to Goal.id (required)
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every tool call returns this in `details`.
 */
export interface TaskDetails {
  action: Action;
  params: Record<string, unknown>;
  goals: Goal[];
  tasks: Task[];
  nextGoalId: number;
  nextId: number;
  // Hot/cold archive slices (excluded from default responses)
  archivedGoals?: Goal[];
  archivedTasks?: Task[];
  error?: string;
}

/**
 * Open-shape input bag the reducer accepts.
 */
export interface TaskMutationParams {
  [key: string]: unknown;
  // Task fields
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  goalId?: number;
  includeDeleted?: boolean;
  // Goal fields
  title?: string;
  file?: string;
  goalStatus?: GoalStatus;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema
// ---------------------------------------------------------------------------

export const TodoParamsSchema = Type.Object({
  action: StringEnum([
    // Task actions
    "create",
    "update",
    "list",
    "get",
    "delete",
    "clear",
    // Goal actions
    "list_goal",
    "add_goal",
    "update_goal",
    "get_goal",
    "complete_goal",
    "abandon_goal",
    "delete_goal",
    "clear_goal",
  ] as const),
  // Task fields
  subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  activeForm: Type.Optional(
    Type.String({
      description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
      description: "Target task status (update) or list filter (list)",
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Initial blockedBy ids (create only)",
    }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Task ids to add to blockedBy (update only, additive merge)",
    }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Task ids to remove from blockedBy (update only, additive merge)",
    }),
  ),
  owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary metadata; pass null value for a key to delete that key on update",
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: "Task id (required for update, get, delete)",
    }),
  ),
  goalId: Type.Optional(
    Type.Number({
      description: "Goal id (required for task create; required for goal actions to target a goal)",
    }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({
      description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
    }),
  ),
  // Goal fields
  title: Type.Optional(Type.String({ description: "Goal title (required for add_goal)" })),
  file: Type.Optional(Type.String({ description: "Repo-relative file path (optional)" })),
  goalStatus: Type.Optional(
    StringEnum(["active", "completed", "abandoned"] as const, {
      description: "Target goal status (update_goal)",
    }),
  ),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

// ---------------------------------------------------------------------------
// Soft cap limits
// ---------------------------------------------------------------------------

export const MAX_TODOS = 50;
export const MAX_GOALS = 20;