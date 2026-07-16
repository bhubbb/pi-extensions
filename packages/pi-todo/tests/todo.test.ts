import { describe, it, expect, beforeEach } from "bun:test";
import { applyTaskMutation } from "../src/state/state-reducer.js";
import { EMPTY_STATE, type TaskState } from "../src/state/state.js";
import { __resetState, getState, commitState } from "../src/state/store.js";
import {
  selectVisibleTasks,
  selectTodoCounts,
  selectTasksByStatus,
  selectActiveGoals,
  selectGoalsByStatus,
  selectTasksByGoal,
  selectGoalIconState,
  selectGoalTaskCounts,
} from "../src/state/selectors.js";
import { renderNestedGoalsLayout } from "../src/view/format.js";
import type { Goal, Task } from "../src/tool/types.js";

describe("pi-todo: Goal and Todo management", () => {
  let state: TaskState;

  beforeEach(() => {
    __resetState();
    state = { ...EMPTY_STATE };
  });

  // -----------------------------------------------------------------------
  // Goal CRUD
  // -----------------------------------------------------------------------

  describe("goals", () => {
    it("add_goal creates a new goal with active status", () => {
      const result = applyTaskMutation(state, "add_goal", { title: "Implement auth" });
      expect(result.op.kind).toBe("create_goal");
      expect(result.state.goals.length).toBe(1);
      expect(result.state.goals[0].status).toBe("active");
      expect(result.state.goals[0].title).toBe("Implement auth");
    });

    it("add_goal requires a title", () => {
      const result = applyTaskMutation(state, "add_goal", { title: "" });
      expect(result.op.kind).toBe("error");
    });

    it("add_goal with description and file stores them", () => {
      const result = applyTaskMutation(state, "add_goal", {
        title: "Implement auth",
        description: "Add OAuth2 login",
        file: "src/auth.ts",
      });
      expect(result.state.goals[0].description).toBe("Add OAuth2 login");
      expect(result.state.goals[0].file).toBe("src/auth.ts");
    });

    it("complete_goal cascades done to all tasks in that goal", () => {
      // Create goal + tasks
      let s = applyTaskMutation(state, "add_goal", { title: "Test goal" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId });

      // Complete goal
      const result = applyTaskMutation(s.state, "complete_goal", { goalId });
      expect(result.op.kind).toBe("complete_goal");
      expect(result.state.goals[0].status).toBe("completed");
      // All tasks should be completed
      for (const task of result.state.tasks) {
        expect(task.status).toBe("completed");
      }
    });

    it("abandon_goal leaves tasks untouched", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Abandoned goal" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "abandon_goal", { goalId });
      expect(result.op.kind).toBe("abandon_goal");
      expect(result.state.goals[0].status).toBe("abandoned");
      // Task should still be in_progress
      expect(result.state.tasks[0].status).toBe("in_progress");
    });

    it("delete_goal removes goal AND all its tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "To delete" });
      const goalId = s.state.goals[0].id;
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId });

      const result = applyTaskMutation(s.state, "delete_goal", { goalId });
      expect(result.op.kind).toBe("delete_goal");
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });

    it("clear_goal removes all goals and tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });
      s = applyTaskMutation(s.state, "create", { subject: "Task", goalId: 1 });

      const result = applyTaskMutation(s.state, "clear_goal", {});
      expect(result.op.kind).toBe("clear_goal");
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });

    it("list_goal returns all goals", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });

      const result = applyTaskMutation(s.state, "list_goal", {});
      expect(result.op.kind).toBe("list_goal");
      expect(result.state.goals.length).toBe(2);
    });

    it("get_goal returns a single goal", () => {
      const s = applyTaskMutation(state, "add_goal", { title: "My goal" });
      const result = applyTaskMutation(s.state, "get_goal", { goalId: 1 });
      expect(result.op.kind).toBe("get_goal");
      expect(result.op.goal.title).toBe("My goal");
    });

    it("soft cap of 20 goals — reuses abandoned goals at cap", () => {
      let s = state;
      // Create 20 goals
      for (let i = 0; i < 20; i++) {
        s = applyTaskMutation(s, "add_goal", { title: `Goal ${i}` }).state;
      }
      // 21st should fail
      let result = applyTaskMutation(s, "add_goal", { title: "Goal 21" });
      expect(result.op.kind).toBe("error");

      // Abandon one goal
      s = applyTaskMutation(s, "abandon_goal", { goalId: 1 }).state;
      // Now 21st should work (reuses abandoned)
      result = applyTaskMutation(s, "add_goal", { title: "Goal 21" });
      expect(result.op.kind).toBe("create_goal");
    });
  });

  // -----------------------------------------------------------------------
  // Task CRUD with goalId
  // -----------------------------------------------------------------------

  describe("tasks", () => {
    it("create requires goalId", () => {
      const result = applyTaskMutation(state, "create", { subject: "Task" });
      expect(result.op.kind).toBe("error");
      expect(result.op.message).toContain("goalId");
    });

    it("create with valid goalId adds task to goal", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      const result = applyTaskMutation(s.state, "create", { subject: "Do thing", goalId: 1 });
      expect(result.op.kind).toBe("create");
      expect(result.state.tasks[0].goalId).toBe(1);
      expect(result.state.tasks[0].subject).toBe("Do thing");
    });

    it("create with invalid goalId errors", () => {
      const result = applyTaskMutation(state, "create", { subject: "Task", goalId: 999 });
      expect(result.op.kind).toBe("error");
    });

    it("soft cap of 50 tasks", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      let current = s.state;
      for (let i = 0; i < 50; i++) {
        current = applyTaskMutation(current, "create", { subject: `Task ${i}`, goalId: 1 }).state;
      }
      const result = applyTaskMutation(current, "create", { subject: "Task 51", goalId: 1 });
      expect(result.op.kind).toBe("error");
      expect(result.op.message).toContain("max tasks");
    });

    it("blockedBy validates deps exist", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      const result = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1, blockedBy: [999] });
      expect(result.op.kind).toBe("error");
    });

    it("blockedBy validates deps not deleted", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "delete", { id: 1 });
      const result = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1, blockedBy: [1] });
      expect(result.op.kind).toBe("error");
    });
  });

  // -----------------------------------------------------------------------
  // Selectors
  // -----------------------------------------------------------------------

  describe("selectors", () => {
    it("selectVisibleTasks excludes deleted", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "delete", { id: 1 });

      const visible = selectVisibleTasks(s.state);
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe(2);
    });

    it("selectTasksByStatus groups correctly", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "P", goalId: 1 }); // pending
      s = applyTaskMutation(s.state, "create", { subject: "I", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "in_progress" });
      s = applyTaskMutation(s.state, "create", { subject: "C", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 3, status: "completed" });

      const groups = selectTasksByStatus(s.state);
      expect(groups.pending.length).toBe(1);
      expect(groups.inProgress.length).toBe(1);
      expect(groups.completed.length).toBe(1);
    });

    it("selectActiveGoals returns only active goals", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Active" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Done" });
      s = applyTaskMutation(s.state, "complete_goal", { goalId: 2 });

      const active = selectActiveGoals(s.state);
      expect(active.length).toBe(1);
      expect(active[0].title).toBe("Active");
    });

    it("selectGoalsByStatus groups by status", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Active" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Done" });
      s = applyTaskMutation(s.state, "complete_goal", { goalId: 2 });
      s = applyTaskMutation(s.state, "add_goal", { title: "Abandoned" });
      s = applyTaskMutation(s.state, "abandon_goal", { goalId: 3 });

      const groups = selectGoalsByStatus(s.state);
      expect(groups.active.length).toBe(1);
      expect(groups.completed.length).toBe(1);
      expect(groups.abandoned.length).toBe(1);
    });

    it("selectTasksByGoal returns tasks for a specific goal", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId: 2 });

      const goal1Tasks = selectTasksByGoal(s.state, 1);
      expect(goal1Tasks.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Referential integrity
  // -----------------------------------------------------------------------

  describe("referential integrity", () => {
    it("add_todo without valid goalId → error, no mutation", () => {
      const result = applyTaskMutation(state, "create", { subject: "Orphan" });
      expect(result.op.kind).toBe("error");
      expect(result.state.tasks.length).toBe(0);
    });

    it("add_todo with bogus goalId → error, no mutation", () => {
      const result = applyTaskMutation(state, "create", { subject: "Orphan", goalId: 999 });
      expect(result.op.kind).toBe("error");
      expect(result.state.tasks.length).toBe(0);
    });

    it("complete_goal cascades todo.done = true", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "complete_goal", { goalId: 1 });
      expect(result.state.tasks[0].status).toBe("completed");
    });

    it("abandon_goal leaves todos untouched", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });

      const result = applyTaskMutation(s.state, "abandon_goal", { goalId: 1 });
      expect(result.state.tasks[0].status).toBe("in_progress");
      expect(result.state.goals[0].status).toBe("abandoned");
    });

    it("clear_goal removes goal + its todos", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });

      const result = applyTaskMutation(s.state, "delete_goal", { goalId: 1 });
      expect(result.state.goals.length).toBe(0);
      expect(result.state.tasks.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Goal icon state (aggregate of task statuses)
  // -----------------------------------------------------------------------

  describe("goal icon state", () => {
    it("not_started when goal has no tasks", () => {
      const s = applyTaskMutation(state, "add_goal", { title: "Empty" });
      expect(selectGoalIconState(s.state, 1)).toBe("not_started");
    });

    it("not_started when all tasks are pending", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      expect(selectGoalIconState(s.state, 1)).toBe("not_started");
    });

    it("in_progress when any task is in_progress", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });
      expect(selectGoalIconState(s.state, 1)).toBe("in_progress");
    });

    it("not_started when some tasks completed and some pending (no explicit in_progress)", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      // No task is in_progress, so icon stays not_started (completed+pending without active work)
      expect(selectGoalIconState(s.state, 1)).toBe("not_started");
    });

    it("in_progress when some completed, some in_progress, some pending", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "in_progress" });
      expect(selectGoalIconState(s.state, 1)).toBe("in_progress");
    });

    it("done when all tasks are completed", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "completed" });
      expect(selectGoalIconState(s.state, 1)).toBe("done");
    });

    it("boundary: single task toggled from pending to done transitions not_started → done", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      expect(selectGoalIconState(s.state, 1)).toBe("not_started");
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });
      expect(selectGoalIconState(s.state, 1)).toBe("in_progress");
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      expect(selectGoalIconState(s.state, 1)).toBe("done");
    });

    it("goal task counts selector", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      expect(selectGoalTaskCounts(s.state, 1)).toEqual({ completed: 1, total: 2 });
    });
  });

  // -----------------------------------------------------------------------
  // Nested overlay layout (pure function, no theme)
  // -----------------------------------------------------------------------

  describe("nested overlay layout", () => {
    it("single goal with three tasks — correct tree chars", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "My Goal" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 3", goalId: 1 });

      const layout = renderNestedGoalsLayout(s.state, new Set());
      // Heading: ○ because all tasks are pending (not_started) — derived from task progress
      expect(layout.heading).toBe("○ Goals (0/1)");
      expect(layout.goalGroups.length).toBe(1);

      const goal = layout.goalGroups[0];
      expect(goal.goalLine).toBe("└─ ○ My Goal (0/3)");
      // Tasks start at #1 (separate counter from goals)
      expect(goal.taskLines).toEqual([
        "   ├─ ○ #1 Task 1",
        "   ├─ ○ #2 Task 2",
        "   └─ ○ #3 Task 3",
      ]);
    });

    it("two goals — first uses ├─ with │  continuation, last uses └─",
      () => {
        let s = applyTaskMutation(state, "add_goal", { title: "Goal A" });
        s = applyTaskMutation(s.state, "add_goal", { title: "Goal B" });
        s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
        s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 2 });

        const layout = renderNestedGoalsLayout(s.state, new Set());
        // Heading: ○ because all tasks are pending — derived from task progress
        expect(layout.heading).toBe("○ Goals (0/2)");
        expect(layout.goalGroups.length).toBe(2);

        // First goal — not last, so ├─ and │  prefix
        expect(layout.goalGroups[0].goalLine).toBe("├─ ○ Goal A (0/1)");
        expect(layout.goalGroups[0].taskLines).toEqual([
          "│  └─ ○ #1 Task 1",
        ]);

        // Second goal — last, so └─ and "   " prefix
        expect(layout.goalGroups[1].goalLine).toBe("└─ ○ Goal B (0/1)");
        expect(layout.goalGroups[1].taskLines).toEqual([
          "   └─ ○ #2 Task 2",
        ]);
      });

    it("goal icon reflects task progress", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Mixed Goal" });
      s = applyTaskMutation(s.state, "create", { subject: "Done", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Working", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Waiting", goalId: 1 });
      // Tasks start at #1 (separate counter from goals)
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "in_progress" });

      const layout = renderNestedGoalsLayout(s.state, new Set());
      // Goal icon = ◐ because a task is in_progress
      expect(layout.goalGroups[0].goalLine).toBe("└─ ◐ Mixed Goal (1/3)");
      expect(layout.goalGroups[0].taskLines[0]).toContain("✓ #1 Done");
      expect(layout.goalGroups[0].taskLines[1]).toContain("◐ #2 Working");
      expect(layout.goalGroups[0].taskLines[2]).toContain("○ #3 Waiting");
    });

    it("all tasks done — goal icon is ✓", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Done Goal" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      // Task starts at #1
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });

      const layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.goalGroups[0].goalLine).toBe("└─ ✓ Done Goal (1/1)");
    });

    it("heading glyph changes with goal aggregate", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Goal 1" });
      s = applyTaskMutation(s.state, "add_goal", { title: "Goal 2" });
      s = applyTaskMutation(s.state, "create", { subject: "T1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "T2", goalId: 2 });

      // All tasks pending — heading ○ (not_started)
      let layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("○ Goals (0/2)");

      // Mark T1 as in_progress — heading ◐ (some work in progress)
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });
      layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("◐ Goals (0/2)");

      // Complete all tasks in both goals — heading ✓ (all done)
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      s = applyTaskMutation(s.state, "update", { id: 2, status: "completed" });
      layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("✓ Goals (2/2)");
    });

    it("empty goal (no tasks) renders with (0/0)", () => {
      const s = applyTaskMutation(state, "add_goal", { title: "Empty" });
      const layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.goalGroups[0].goalLine).toBe("└─ ○ Empty (0/0)");
      expect(layout.goalGroups[0].taskLines).toEqual([]);
    });

    it("hidden completed tasks are excluded from layout", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });
      s = applyTaskMutation(s.state, "create", { subject: "Task 2", goalId: 1 });
      // Tasks start at #1
      s = applyTaskMutation(s.state, "update", { id: 2, status: "completed" });

      // Hide task #2 (the completed one)
      const layout = renderNestedGoalsLayout(s.state, new Set([2]));
      expect(layout.goalGroups[0].taskLines.length).toBe(1);
      expect(layout.goalGroups[0].taskLines[0]).toContain("#1 Task 1");
    });

    // Regression: heading glyph must match goal icon state (both derived from task progress)
    // Previously heading used explicit goal status while icons used derived task progress,
    // causing mismatch when all tasks were done but goal status was still 'active'.
    it("heading and goal icons stay consistent across all three task states", () => {
      let s = applyTaskMutation(state, "add_goal", { title: "Test Goal" });
      s = applyTaskMutation(s.state, "create", { subject: "Task 1", goalId: 1 });

      // State 1: all tasks pending (not_started) — heading ○, goal ○
      let layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("○ Goals (0/1)");
      expect(layout.goalGroups[0].goalLine).toBe("└─ ○ Test Goal (0/1)");

      // State 2: task in_progress — heading ◐, goal ◐
      s = applyTaskMutation(s.state, "update", { id: 1, status: "in_progress" });
      layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("◐ Goals (0/1)");
      expect(layout.goalGroups[0].goalLine).toBe("└─ ◐ Test Goal (0/1)");

      // State 3: all tasks completed (goal still 'active' — not complete_goal'd)
      // heading ✓, goal ✓ — this was the bug: heading showed ◐ while goal showed ✓
      s = applyTaskMutation(s.state, "update", { id: 1, status: "completed" });
      layout = renderNestedGoalsLayout(s.state, new Set());
      expect(layout.heading).toBe("✓ Goals (1/1)");
      expect(layout.goalGroups[0].goalLine).toBe("└─ ✓ Test Goal (1/1)");
    });
  });
});